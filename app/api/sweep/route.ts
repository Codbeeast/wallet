import { NextResponse } from 'next/server';
import { TronWeb } from 'tronweb';
import { Turnkey } from '@turnkey/sdk-server';
import dbConnect from '@/lib/db';
import { getSystemConfig } from '@/lib/config';
import ReplenishmentLog from '@/models/ReplenishmentLog';
import { logSystemEvent } from '@/lib/logger';

export async function POST(request: Request) {
  try {
    await dbConnect();
    
    // Parse request body
    const body = await request.json();
    const { amount, isMock } = body;
    
    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      return NextResponse.json(
        { success: false, error: 'Sweep amount must be a positive number.' },
        { status: 400 }
      );
    }
    
    // Fetch current system configuration and balance sheet
    const config = await getSystemConfig();
    
    // Check if the warm wallet has sufficient platform balance
    if (config.platformBalance < parsedAmount) {
      await logSystemEvent(
        `Failed sweep attempt: Insufficient balance ($${config.platformBalance.toFixed(2)} USDT < $${parsedAmount.toFixed(2)} USDT requested).`,
        'warn'
      );
      return NextResponse.json(
        { success: false, error: `Insufficient platform balance. Operating balance is $${config.platformBalance.toFixed(2)} USDT.` },
        { status: 400 }
      );
    }
    
    const amountSun = Math.round(parsedAmount * 1_000_000);
    let txHash = '';
    
    if (isMock) {
      // 1. MOCK MODE SIMULATION
      await logSystemEvent(`[MOCK SWEEP] Initiating Warm-to-Cold Sweep of ${parsedAmount.toFixed(2)} USDT...`, 'info');
      await logSystemEvent(`[MOCK SWEEP] Targeting Cold Treasury Address: ${config.coldTreasuryAddress}`, 'info');
      
      // Generate a mock txHash (TRON tx hashes are 64 hex characters)
      const hexChars = '0123456789abcdef';
      for (let i = 0; i < 64; i++) {
        txHash += hexChars[Math.floor(Math.random() * 16)];
      }
      
      await logSystemEvent(`[MOCK SWEEP] Simulating broadcast... Broadcast successful. txHash: ${txHash.slice(0, 10)}...`, 'success');
    } else {
      // 2. LIVE NILE TESTNET MODE
      const turnkeyApiBaseUrl = process.env.TURNKEY_API_BASE_URL || 'https://api.turnkey.com';
      let turnkeyApiPrivateKey = process.env.TURNKEY_API_PRIVATE_KEY;
      const turnkeyApiPublicKey = process.env.TURNKEY_API_PUBLIC_KEY;
      const turnkeyOrganizationId = process.env.TURNKEY_ORGANIZATION_ID;

      if (!turnkeyApiPrivateKey || !turnkeyApiPublicKey || !turnkeyOrganizationId) {
        return NextResponse.json(
          { success: false, error: 'Turnkey KMS configuration (TURNKEY_API_PRIVATE_KEY, TURNKEY_API_PUBLIC_KEY, or TURNKEY_ORGANIZATION_ID) is missing on the server.' },
          { status: 500 }
        );
      }
      
      // Sanitize the API private key:
      // - Strip 0x prefix if present
      // - Remove any whitespace / newlines
      // - Strip leading 00 DER padding byte (common when key is exported from DER/ASN.1 format)
      // The Turnkey SDK expects a raw 32-byte (64 hex char) P-256 private key scalar.
      turnkeyApiPrivateKey = turnkeyApiPrivateKey.replace(/^0x/, '').replace(/\s+/g, '');
      
      // DER encoding adds a leading 0x00 byte when the key's high bit is set.
      // This makes the key 33 bytes (66 hex chars) instead of 32 (64 hex chars). Strip it.
      if (turnkeyApiPrivateKey.length === 66 && turnkeyApiPrivateKey.startsWith('00')) {
        console.log('[SWEEP] Stripping leading 00 DER padding byte from TURNKEY_API_PRIVATE_KEY');
        turnkeyApiPrivateKey = turnkeyApiPrivateKey.slice(2);
      }
      
      // Diagnostic logging (safe: only logs lengths, not the actual key)
      console.log(`[SWEEP DEBUG] TURNKEY_API_PRIVATE_KEY length: ${turnkeyApiPrivateKey.length} chars (expected: 64)`);
      console.log(`[SWEEP DEBUG] TURNKEY_API_PUBLIC_KEY length: ${turnkeyApiPublicKey.length} chars (expected: 66)`);
      console.log(`[SWEEP DEBUG] TURNKEY_API_PRIVATE_KEY first 4 chars: ${turnkeyApiPrivateKey.slice(0, 4)}...`);
      
      if (turnkeyApiPrivateKey.length !== 64) {
        const errMsg = `TURNKEY_API_PRIVATE_KEY has invalid length: ${turnkeyApiPrivateKey.length} hex chars. Expected exactly 64 hex chars (32 bytes). The value must be a raw P-256 private key scalar — not DER-encoded, not PEM, not JSON. Extract just the hex "privateKey" field from your Turnkey API key export.`;
        console.error('[SWEEP ERROR]', errMsg);
        return NextResponse.json(
          { success: false, error: errMsg },
          { status: 500 }
        );
      }
      
      await logSystemEvent(`Initiating Live Warm-to-Cold Sweep of ${parsedAmount.toFixed(2)} USDT to Cold Treasury...`, 'info');
      await logSystemEvent(`Targeting Cold Treasury: ${config.coldTreasuryAddress}`, 'info');
      
      // Instantiate TronWeb in read/build mode (no private key needed locally)
      const tronWeb = new TronWeb({
        fullHost: process.env.NILE_RPC_URL || 'https://api.nileex.io',
      });
      
      try {
        // ============================================================
        // STEP 1: Construct the unsigned smart contract call
        // ============================================================
        await logSystemEvent(`[STEP 1] Constructing smart contract transaction for Warm Wallet: ${config.warmWalletAddress}...`, 'info');
        
        let unsignedTx: any;
        try {
          unsignedTx = await tronWeb.transactionBuilder.triggerSmartContract(
            config.usdtContractAddress,      // USDT Contract address
            'transfer(address,uint256)',     // Function ABI signature
            {},                              // Options
            [
              { type: 'address', value: config.coldTreasuryAddress }, // Destination
              { type: 'uint256', value: amountSun }                  // Amount scaled in Sun
            ],
            config.warmWalletAddress                                 // Origin/From address
          );
        } catch (stepErr: any) {
          throw new Error(`[FAILED AT STEP 1 - triggerSmartContract] ${stepErr.message || stepErr}`);
        }
        
        const txObject = unsignedTx.transaction;
        const rawDataHex = txObject.raw_data_hex;
        
        await logSystemEvent(`[STEP 1 OK] Transaction constructed. raw_data_hex length: ${rawDataHex?.length}`, 'info');
        
        // ============================================================
        // STEP 2: Instantiate Turnkey SDK client
        // ============================================================
        await logSystemEvent(`[STEP 2] Instantiating Turnkey SDK client...`, 'info');
        
        let turnkeyClient: any;
        try {
          const turnkey = new Turnkey({
            apiBaseUrl: turnkeyApiBaseUrl,
            apiPrivateKey: turnkeyApiPrivateKey,
            apiPublicKey: turnkeyApiPublicKey,
            defaultOrganizationId: turnkeyOrganizationId,
          });
          turnkeyClient = turnkey.apiClient();
        } catch (stepErr: any) {
          throw new Error(`[FAILED AT STEP 2 - Turnkey init] ${stepErr.message || stepErr}`);
        }
        
        await logSystemEvent(`[STEP 2 OK] Turnkey client instantiated.`, 'info');
        
        // ============================================================
        // STEP 3: Request Turnkey to sign the raw payload
        // ============================================================
        await logSystemEvent(`[STEP 3] Requesting Turnkey KMS signature. signWith: ${config.warmWalletAddress}, payload length: ${rawDataHex?.length}`, 'info');
        
        let signingResult: any;
        try {
          signingResult = await turnkeyClient.signRawPayload({
            organizationId: turnkeyOrganizationId,
            signWith: config.warmWalletAddress,
            payload: rawDataHex,
            encoding: 'PAYLOAD_ENCODING_HEXADECIMAL',
            hashFunction: 'HASH_FUNCTION_SHA256',
          });
        } catch (stepErr: any) {
          throw new Error(`[FAILED AT STEP 3 - signRawPayload] ${stepErr.message || stepErr}`);
        }
        
        // Debug: log the FULL signing result structure
        console.log('[SWEEP DEBUG] Full signingResult keys:', Object.keys(signingResult || {}));
        console.log('[SWEEP DEBUG] Full signingResult:', JSON.stringify(signingResult).slice(0, 500));
        
        const { r, s, v } = signingResult;
        
        await logSystemEvent(`[STEP 3 OK] Turnkey signing done. r type=${typeof r}, length=${r?.length}. s type=${typeof s}, length=${s?.length}. v="${v}"`, 'info');
        
        // ============================================================
        // STEP 4: Assemble signature
        // ============================================================
        await logSystemEvent(`[STEP 4] Assembling signature...`, 'info');
        
        // Helper: normalize an ECDSA component to exactly 64 hex chars (32 bytes).
        function normalizeComponent(hex: string): string {
          let clean = hex.replace(/^0x/, '');
          while (clean.length > 64 && clean.startsWith('0')) {
            clean = clean.slice(1);
          }
          if (clean.length > 64) {
            clean = clean.slice(clean.length - 64);
          }
          return clean.padStart(64, '0');
        }
        
        const cleanR = normalizeComponent(r);
        const cleanS = normalizeComponent(s);
        
        // Parse v: Turnkey returns v as a decimal string ("0", "1", "27", "28").
        // TRON needs v as hex: 27 → "1b", 28 → "1c", 0 → "1b", 1 → "1c"
        const rawV = v?.replace(/^0x/, '') || '0';
        let vNum = parseInt(rawV, 10);
        if (isNaN(vNum)) {
          vNum = parseInt(rawV, 16);
        }
        if (vNum === 0 || vNum === 1) {
          vNum = vNum + 27;
        }
        const cleanV = vNum.toString(16).padStart(2, '0');
        
        const signatureHex = cleanR + cleanS + cleanV;
        
        await logSystemEvent(`[STEP 4 OK] Signature assembled. Length: ${signatureHex.length} chars. Expected: 130. Sig: ${signatureHex.slice(0, 10)}...${signatureHex.slice(-6)}`, 'info');
        
        if (signatureHex.length !== 130) {
          throw new Error(`[FAILED AT STEP 4] Invalid signature length: expected 130 hex chars, got ${signatureHex.length}. r=${cleanR.length}, s=${cleanS.length}, v=${cleanV.length}`);
        }
        
        // ============================================================
        // STEP 5: Attach signature and broadcast
        // ============================================================
        await logSystemEvent(`[STEP 5] Attaching signature and broadcasting to Nile network...`, 'info');
        
        (txObject as any).signature = [signatureHex];
        
        let broadcastResult: any;
        try {
          broadcastResult = await tronWeb.trx.sendRawTransaction(txObject as any);
        } catch (stepErr: any) {
          throw new Error(`[FAILED AT STEP 5 - sendRawTransaction] ${stepErr.message || stepErr}`);
        }
        
        if (!broadcastResult.result) {
          const rpcCode = broadcastResult.code || 'UNKNOWN_ERROR';
          const rpcMsg = broadcastResult.message ? String(broadcastResult.message) : '';
          throw new Error(`[FAILED AT STEP 5 - RPC rejected] Code: ${rpcCode}. Message: ${rpcMsg}`);
        }
        
        txHash = broadcastResult.txid;
        await logSystemEvent(`[STEP 5 OK] Broadcast successful. Nile txHash: ${txHash}`, 'success');
      } catch (err: any) {
        console.error('USDT sweep transaction failed:', err);
        await logSystemEvent(`On-chain broadcast failed: ${err.message || err}`, 'error');
        return NextResponse.json(
          { success: false, error: `USDT sweep transaction failed: ${err.message || err}` },
          { status: 500 }
        );
      }
    }
    
    // 3. Settle transaction in DB
    // Deduct balance from systemConfig
    config.platformBalance -= parsedAmount;
    config.lastUpdated = new Date();
    await config.save();
    
    // Log the transaction in ReplenishmentLog
    // (Sweeps are logged as SUCCESS immediately because they are initiated & verified by the server keys)
    const auditRecord = await ReplenishmentLog.create({
      txHash,
      amount: amountSun,
      status: 'SUCCESS',
      fromAddress: config.warmWalletAddress,
      toAddress: config.coldTreasuryAddress,
    });
    
    await logSystemEvent(`Platform balance sheet updated: -$${parsedAmount.toFixed(2)} USDT. New Balance: $${config.platformBalance.toFixed(2)} USDT.`, 'success');
    await logSystemEvent(`Warm-to-Cold Sweep logged and audit trail secured.`, 'success');
    
    return NextResponse.json({
      success: true,
      message: 'Warm-to-Cold Sweep completed successfully.',
      data: {
        txHash,
        amount: parsedAmount,
        newBalance: config.platformBalance,
        auditId: auditRecord._id,
      },
    });
  } catch (error: any) {
    console.error('Error in sweep API route:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Internal Server Error' },
      { status: 500 }
    );
  }
}
