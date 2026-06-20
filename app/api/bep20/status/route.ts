import { NextResponse } from 'next/server';
import dbConnect from '@/lib/db';
import { getBSCSystemConfig } from '@/lib/configBSC';
import { getBSCUSDTBalance } from '@/lib/bsc';
import ReplenishmentLogBEP20 from '@/models/ReplenishmentLogBEP20';
import { ethers } from 'ethers';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await dbConnect();

    const config = await getBSCSystemConfig();

    // Fetch live on-chain USDT balance from BSC
    const warmWalletBalanceOnChain = await getBSCUSDTBalance(
      config.warmWalletAddress,
      config.usdtContractAddress
    );

    // Check for active mutex lock
    const activeLockDoc = await ReplenishmentLogBEP20.findOne({ status: 'PROCESSING' });
    const isLocked = !!activeLockDoc;

    const isLowFunds = config.platformBalance < config.lowFundsThreshold;

    const logs = await ReplenishmentLogBEP20.find()
      .sort({ createdAt: -1 })
      .limit(15);

    // Convert Wei string amounts to USDT for display
    const logsForDisplay = logs.map((log: any) => ({
      ...log.toObject(),
      amountUSDT: parseFloat(ethers.formatUnits(log.amount || '0', 18)),
    }));

    return NextResponse.json({
      success: true,
      data: {
        platformBalance: config.platformBalance,
        lowFundsThreshold: config.lowFundsThreshold,
        warmWalletAddress: config.warmWalletAddress,
        usdtContractAddress: config.usdtContractAddress,
        coldTreasuryAddress: config.coldTreasuryAddress,
        warmWalletBalanceOnChain,
        isLowFunds,
        isLocked,
        activeLockTxHash: activeLockDoc?.txHash || null,
        logs: logsForDisplay,
      },
    });
  } catch (error: any) {
    console.error('[BSC] Error in status API route:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Internal Server Error' },
      { status: 500 }
    );
  }
}
