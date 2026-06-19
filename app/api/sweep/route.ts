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
      const turnkeyApiPrivateKey = process.env.TURNKEY_API_PRIVATE_KEY;
      const turnkeyApiPublicKey = process.env.TURNKEY_API_PUBLIC_KEY;
      const turnkeyOrganizationId = process.env.TURNKEY_ORGANIZATION_ID;

      if (!turnkeyApiPrivateKey || !turnkeyApiPublicKey || !turnkeyOrganizationId) {
        return NextResponse.json(
          { success: false, error: 'Turnkey KMS configuration (TURNKEY_API_PRIVATE_KEY, TURNKEY_API_PUBLIC_KEY, or TURNKEY_ORGANIZATION_ID) is missing on the server.' },
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
        await logSystemEvent(`Constructing smart contract transaction for Warm Wallet: ${config.warmWalletAddress}...`, 'info');
        
        // 1. Construct the unsigned smart contract call
        const unsignedTx = await tronWeb.transactionBuilder.triggerSmartContract(
          config.usdtContractAddress,      // USDT Contract address
          'transfer(address,uint256)',     // Function ABI signature
          {},                              // Options
          [
            { type: 'address', value: config.coldTreasuryAddress }, // Destination
            { type: 'uint256', value: amountSun }                  // Amount scaled in Sun
          ],
          config.warmWalletAddress                                 // Origin/From address
        );
        
        const txObject = unsignedTx.transaction;
        const rawDataHex = txObject.raw_data_hex;
        
        await logSystemEvent(`Requesting Turnkey KMS signature for payload...`, 'info');
        
        // 2. Instantiate Turnkey SDK client
        const turnkey = new Turnkey({
          apiBaseUrl: turnkeyApiBaseUrl,
          apiPrivateKey: turnkeyApiPrivateKey,
          apiPublicKey: turnkeyApiPublicKey,
          defaultOrganizationId: turnkeyOrganizationId,
        });
        
        const turnkeyClient = turnkey.apiClient();
        
        // 3. Request Turnkey to sign the raw payload
        const signingResult = await turnkeyClient.signRawPayload({
          organizationId: turnkeyOrganizationId,
          signWith: config.warmWalletAddress,
          payload: rawDataHex,
          encoding: 'PAYLOAD_ENCODING_HEXADECIMAL',
          hashFunction: 'HASH_FUNCTION_SHA256',
        });
        
        const { r, s, v } = signingResult;
        const signatureHex = r + s + v;
        
        await logSystemEvent(`Turnkey KMS signature received. Assembling and broadcasting to Nile network...`, 'info');
        
        // 4. Attach signature to transaction object
        (txObject as any).signature = [signatureHex];
        
        // 5. Broadcast signed transaction to Nile Testnet RPC
        const broadcastResult = await tronWeb.trx.sendRawTransaction(txObject as any);
        
        if (!broadcastResult.result) {
          const rpcCode = broadcastResult.code || 'UNKNOWN_ERROR';
          const rpcMsg = broadcastResult.message ? String(broadcastResult.message) : '';
          throw new Error(`RPC node broadcast rejected. Code: ${rpcCode}. Message: ${rpcMsg}`);
        }
        
        txHash = broadcastResult.txid;
        await logSystemEvent(`Broadcast successful. Nile txHash: ${txHash}`, 'success');
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
