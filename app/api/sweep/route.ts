import { NextResponse } from 'next/server';
import { TronWeb } from 'tronweb';
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
      const privateKey = process.env.WARM_WALLET_PRIVATE_KEY;
      if (!privateKey) {
        return NextResponse.json(
          { success: false, error: 'Warm Wallet private key configuration is missing on the server.' },
          { status: 500 }
        );
      }
      
      await logSystemEvent(`Initiating Live Warm-to-Cold Sweep of ${parsedAmount.toFixed(2)} USDT to Cold Treasury...`, 'info');
      await logSystemEvent(`Targeting Cold Treasury: ${config.coldTreasuryAddress}`, 'info');
      
      // Instantiate TronWeb with the private key so it can sign the trigger locally
      const tronWeb = new TronWeb({
        fullHost: process.env.NILE_RPC_URL || 'https://api.nileex.io',
        privateKey,
      });
      
      try {
        // Load the contract and call transfer function, sending the transaction
        const contract = await tronWeb.contract().at(config.usdtContractAddress);
        
        // contract.method().send() handles build, sign, and broadcast
        const receiptTxHash = await contract.transfer(config.coldTreasuryAddress, amountSun).send();
        txHash = receiptTxHash;
        
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
