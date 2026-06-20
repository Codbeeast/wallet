import { NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { Turnkey } from '@turnkey/sdk-server';
import dbConnect from '@/lib/db';
import { getBSCSystemConfig } from '@/lib/configBSC';
import ReplenishmentLogBEP20 from '@/models/ReplenishmentLogBEP20';
import { logSystemEvent } from '@/lib/logger';
import { getBSCProvider, ERC20_ABI } from '@/lib/bsc';

export async function POST(request: Request) {
  try {
    await dbConnect();

    const body = await request.json();
    const { amount, isMock } = body;

    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      return NextResponse.json(
        { success: false, error: 'Sweep amount must be a positive number.' },
        { status: 400 }
      );
    }

    const config = await getBSCSystemConfig();

    if (config.platformBalance < parsedAmount) {
      await logSystemEvent(
        `[BSC] Failed sweep: Insufficient balance ($${config.platformBalance.toFixed(2)} < $${parsedAmount.toFixed(2)} USDT).`,
        'warn'
      );
      return NextResponse.json(
        { success: false, error: `Insufficient BSC platform balance. Operating balance is $${config.platformBalance.toFixed(2)} USDT.` },
        { status: 400 }
      );
    }

    // Amount in Wei (18 decimals)
    const amountWei = ethers.parseUnits(parsedAmount.toString(), 18);
    let txHash = '';

    if (isMock) {
      // === MOCK MODE ===
      await logSystemEvent(`[BSC MOCK SWEEP] Initiating Warm-to-Cold Sweep of ${parsedAmount.toFixed(2)} USDT...`, 'info');
      await logSystemEvent(`[BSC MOCK SWEEP] Targeting Cold Treasury: ${config.coldTreasuryAddress}`, 'info');

      // Generate mock EVM tx hash: 0x + 64 hex chars
      const hexChars = '0123456789abcdef';
      let mockHash = '0x';
      for (let i = 0; i < 64; i++) {
        mockHash += hexChars[Math.floor(Math.random() * 16)];
      }
      txHash = mockHash;

      await logSystemEvent(`[BSC MOCK SWEEP] Simulated broadcast complete. txHash: ${txHash.slice(0, 12)}...`, 'success');
    } else {
      // === LIVE BSC MODE ===
      const turnkeyApiBaseUrl = process.env.TURNKEY_API_BASE_URL || 'https://api.turnkey.com';
      let turnkeyApiPrivateKey = process.env.TURNKEY_API_PRIVATE_KEY;
      const turnkeyApiPublicKey = process.env.TURNKEY_API_PUBLIC_KEY;
      const turnkeyOrganizationId = process.env.TURNKEY_ORGANIZATION_ID;

      if (!turnkeyApiPrivateKey || !turnkeyApiPublicKey || !turnkeyOrganizationId) {
        return NextResponse.json(
          { success: false, error: 'Turnkey KMS configuration is missing on the server.' },
          { status: 500 }
        );
      }

      // Sanitize Turnkey private key
      turnkeyApiPrivateKey = turnkeyApiPrivateKey.replace(/^0x/, '').replace(/\s+/g, '');
      if (turnkeyApiPrivateKey.length === 66 && turnkeyApiPrivateKey.startsWith('00')) {
        turnkeyApiPrivateKey = turnkeyApiPrivateKey.slice(2);
      }

      if (turnkeyApiPrivateKey.length !== 64) {
        return NextResponse.json(
          { success: false, error: `TURNKEY_API_PRIVATE_KEY has invalid length: ${turnkeyApiPrivateKey.length}. Expected 64 hex chars.` },
          { status: 500 }
        );
      }

      await logSystemEvent(`[BSC] Initiating Live Warm-to-Cold Sweep of ${parsedAmount.toFixed(2)} USDT...`, 'info');

      const provider = getBSCProvider();
      const network = await provider.getNetwork();
      const chainId = network.chainId; // BSC Testnet = 97n, Mainnet = 56n

      try {
        // ============================================================
        // STEP 1: Encode ERC-20 transfer call data
        // ============================================================
        await logSystemEvent(`[BSC STEP 1] Encoding BEP-20 transfer(address,uint256) calldata...`, 'info');

        const iface = new ethers.Interface(ERC20_ABI);
        const callData = iface.encodeFunctionData('transfer', [
          config.coldTreasuryAddress,
          amountWei,
        ]);

        await logSystemEvent(`[BSC STEP 1 OK] Calldata encoded. Length: ${callData.length} chars`, 'info');

        // ============================================================
        // STEP 2: Fetch nonce and gas parameters for warm wallet
        // ============================================================
        await logSystemEvent(`[BSC STEP 2] Fetching nonce and gas parameters for ${config.warmWalletAddress}...`, 'info');

        const nonce = await provider.getTransactionCount(config.warmWalletAddress, 'latest');
        const feeData = await provider.getFeeData();
        const gasPrice = feeData.gasPrice ?? ethers.parseUnits('10', 'gwei');

        // Estimate gas for the transfer call
        let gasLimit: bigint;
        try {
          gasLimit = await provider.estimateGas({
            from: config.warmWalletAddress,
            to: config.usdtContractAddress,
            data: callData,
          });
          // Add 20% buffer
          gasLimit = (gasLimit * BigInt(120)) / BigInt(100);
        } catch {
          gasLimit = BigInt(100000); // Safe fallback for ERC-20 transfers
        }

        await logSystemEvent(`[BSC STEP 2 OK] Nonce: ${nonce}, GasPrice: ${ethers.formatUnits(gasPrice, 'gwei')} gwei, GasLimit: ${gasLimit}`, 'info');

        // ============================================================
        // STEP 3: Build the unsigned transaction object
        // ============================================================
        await logSystemEvent(`[BSC STEP 3] Building unsigned EVM transaction...`, 'info');

        const unsignedTx: ethers.TransactionLike = {
          to: config.usdtContractAddress,
          from: config.warmWalletAddress,
          nonce,
          gasLimit,
          gasPrice,
          data: callData,
          chainId,
          value: BigInt(0),
          type: 0, // Legacy tx (type-0) for broad BSC node compatibility
        };

        // Serialize and get the raw bytes to sign
        const txForSigning = ethers.Transaction.from(unsignedTx);
        const unsignedSerialised = txForSigning.unsignedSerialized;
        // Turnkey signs the keccak256 hash of the serialized transaction
        const payloadToSign = ethers.keccak256(unsignedSerialised).slice(2); // remove 0x

        await logSystemEvent(`[BSC STEP 3 OK] Unsigned tx built. Payload hash to sign: ${payloadToSign.slice(0, 10)}...`, 'info');

        // ============================================================
        // STEP 4: Request Turnkey KMS signature
        // ============================================================
        await logSystemEvent(`[BSC STEP 4] Requesting Turnkey KMS signature. signWith: ${config.warmWalletAddress}`, 'info');

        const turnkey = new Turnkey({
          apiBaseUrl: turnkeyApiBaseUrl,
          apiPrivateKey: turnkeyApiPrivateKey,
          apiPublicKey: turnkeyApiPublicKey,
          defaultOrganizationId: turnkeyOrganizationId,
        });
        const turnkeyClient = turnkey.apiClient();

        const signingResult = await turnkeyClient.signRawPayload({
          organizationId: turnkeyOrganizationId,
          signWith: config.warmWalletAddress,
          payload: payloadToSign,
          encoding: 'PAYLOAD_ENCODING_HEXADECIMAL',
          hashFunction: 'HASH_FUNCTION_NO_OP', // We pre-hashed with keccak256
        });

        const { r, s, v } = signingResult;
        await logSystemEvent(`[BSC STEP 4 OK] Turnkey signing complete. r.len=${r?.length}, s.len=${s?.length}, v="${v}"`, 'info');

        // ============================================================
        // STEP 5: Assemble EIP-155 compliant signature and broadcast
        // ============================================================
        await logSystemEvent(`[BSC STEP 5] Assembling signature and broadcasting to BSC...`, 'info');

        function normalizeHex(hex: string, length: number): string {
          let clean = hex.replace(/^0x/, '');
          while (clean.length > length && clean.startsWith('0')) clean = clean.slice(1);
          if (clean.length > length) clean = clean.slice(clean.length - length);
          return clean.padStart(length, '0');
        }

        const cleanR = normalizeHex(r, 64);
        const cleanS = normalizeHex(s, 64);

        // EIP-155 v calculation: v = chainId * 2 + 35 or 36
        // Turnkey returns v as 0 or 1 (or 27/28 legacy)
        let vNum = parseInt(v?.replace(/^0x/, '') || '0', 10);
        if (isNaN(vNum)) vNum = parseInt(v?.replace(/^0x/, '') || '0', 16);
        if (vNum === 27 || vNum === 28) vNum = vNum - 27; // normalize to 0/1
        const eip155V = BigInt(chainId) * BigInt(2) + BigInt(35) + BigInt(vNum);

        // Attach signature to tx and serialize
        const signedTx = ethers.Transaction.from({
          ...unsignedTx,
          signature: {
            r: '0x' + cleanR,
            s: '0x' + cleanS,
            v: Number(eip155V),
          },
        });

        const broadcastResult = await provider.broadcastTransaction(signedTx.serialized);
        await broadcastResult.wait(1); // wait 1 confirmation

        txHash = broadcastResult.hash;
        await logSystemEvent(`[BSC STEP 5 OK] Broadcast successful. txHash: ${txHash}`, 'success');
      } catch (err: any) {
        console.error('[BSC] Sweep transaction failed:', err);
        await logSystemEvent(`[BSC] On-chain broadcast failed: ${err.message || err}`, 'error');
        return NextResponse.json(
          { success: false, error: `BSC USDT sweep failed: ${err.message || err}` },
          { status: 500 }
        );
      }
    }

    // 3. Settle in DB
    config.platformBalance -= parsedAmount;
    config.lastUpdated = new Date();
    await config.save();

    const auditRecord = await ReplenishmentLogBEP20.create({
      txHash,
      amount: amountWei.toString(),
      status: 'SUCCESS',
      fromAddress: config.warmWalletAddress,
      toAddress: config.coldTreasuryAddress,
    });

    await logSystemEvent(`[BSC] Balance sheet updated: -$${parsedAmount.toFixed(2)} USDT. New Balance: $${config.platformBalance.toFixed(2)} USDT.`, 'success');
    await logSystemEvent(`[BSC] Warm-to-Cold Sweep logged. Audit trail secured.`, 'success');

    return NextResponse.json({
      success: true,
      message: 'BSC Warm-to-Cold Sweep completed successfully.',
      data: {
        txHash,
        amount: parsedAmount,
        newBalance: config.platformBalance,
        auditId: auditRecord._id,
      },
    });
  } catch (error: any) {
    console.error('[BSC] Error in sweep API route:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Internal Server Error' },
      { status: 500 }
    );
  }
}
