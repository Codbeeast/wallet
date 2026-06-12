import { NextResponse } from 'next/server';
import dbConnect from '@/lib/db';
import { getSystemConfig } from '@/lib/config';
import { getUSDTBalance } from '@/lib/tron';
import ReplenishmentLog from '@/models/ReplenishmentLog';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await dbConnect();
    
    // Fetch configuration and balance sheet
    const config = await getSystemConfig();
    
    // Fetch the live warm wallet on-chain balance on Nile Testnet
    const warmWalletBalanceOnChain = await getUSDTBalance(
      config.warmWalletAddress,
      config.usdtContractAddress
    );
    
    // Check if there is an active mutex lock (any document in PROCESSING state)
    const activeLockDoc = await ReplenishmentLog.findOne({ status: 'PROCESSING' });
    const isLocked = !!activeLockDoc;
    
    // Determine system status alert based on funds compared to threshold
    // We compare the platform internal balance with the low funds threshold
    const isLowFunds = config.platformBalance < config.lowFundsThreshold;
    
    // Fetch recent replenishment logs (limit 15, sorted by latest)
    const logs = await ReplenishmentLog.find()
      .sort({ createdAt: -1 })
      .limit(15);
      
    return NextResponse.json({
      success: true,
      data: {
        platformBalance: config.platformBalance,
        lowFundsThreshold: config.lowFundsThreshold,
        warmWalletAddress: config.warmWalletAddress,
        usdtContractAddress: config.usdtContractAddress,
        warmWalletBalanceOnChain,
        isLowFunds,
        isLocked,
        activeLockTxHash: activeLockDoc?.txHash || null,
        logs,
      },
    });
  } catch (error: any) {
    console.error('Error in status API route:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Internal Server Error' },
      { status: 500 }
    );
  }
}
