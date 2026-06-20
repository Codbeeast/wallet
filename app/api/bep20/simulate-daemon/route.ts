import { NextResponse } from 'next/server';
import dbConnect from '@/lib/db';
import DaemonLogBEP20 from '@/models/DaemonLogBEP20';
import ReplenishmentLogBEP20 from '@/models/ReplenishmentLogBEP20';
import { getBSCSystemConfig } from '@/lib/configBSC';
import { ethers } from 'ethers';

export const dynamic = 'force-dynamic';

// GET: Fetch the latest BSC daemon logs for the live console
export async function GET() {
  try {
    await dbConnect();
    const logs = await DaemonLogBEP20.find()
      .sort({ createdAt: -1 })
      .limit(40);

    return NextResponse.json({
      success: true,
      logs: logs.reverse(),
    });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

async function logBSCDaemonEvent(message: string, type: 'info' | 'success' | 'warn' | 'error' = 'info') {
  await DaemonLogBEP20.create({ message, type });
}

// POST: Trigger simulated BSC daemon events or reset environment
export async function POST(request: Request) {
  try {
    await dbConnect();
    const body = await request.json();
    const { action, txHash } = body;

    const config = await getBSCSystemConfig();

    if (action === 'confirm') {
      if (!txHash) {
        return NextResponse.json({ success: false, error: 'txHash is required for confirmation.' }, { status: 400 });
      }

      const logDoc = await ReplenishmentLogBEP20.findOne({ txHash, status: 'PROCESSING' });
      if (!logDoc) {
        return NextResponse.json({ success: false, error: 'No PROCESSING BSC replenishment found for this hash.' }, { status: 404 });
      }

      const amountUSDT = parseFloat(ethers.formatUnits(logDoc.amount || '0', 18));

      await logBSCDaemonEvent(`[BSC] Daemon intercepted matching Transfer event for txHash: ${txHash.slice(0, 12)}...`, 'info');
      await logBSCDaemonEvent(`[BSC] Verifying on-chain details. Destination: ${logDoc.toAddress}, Amount: ${amountUSDT.toFixed(2)} USDT`, 'info');

      logDoc.status = 'SUCCESS';
      await logDoc.save();
      await logBSCDaemonEvent(`[BSC] Verification successful. Transaction status: SUCCESS. BEP-20 amount verified.`, 'success');

      config.platformBalance += amountUSDT;
      await config.save();
      await logBSCDaemonEvent(`[BSC] Platform balance updated: +${amountUSDT.toFixed(2)} USDT. New Balance: ${config.platformBalance.toFixed(2)} USDT`, 'success');
      await logBSCDaemonEvent(`[BSC] Mutex lock released. System ready for next replenishment.`, 'success');

      return NextResponse.json({
        success: true,
        message: 'BSC transaction confirmed and platform balance updated.',
      });
    }

    if (action === 'trigger-funds-low') {
      config.platformBalance = 10240.50;
      await config.save();
      await logBSCDaemonEvent(`[BSC] Balance updated to low funds state: ${config.platformBalance} USDT (Threshold: ${config.lowFundsThreshold} USDT)`, 'warn');
      await logBSCDaemonEvent(`[BSC] Status Alert: LOW_FUNDS. Action Required: Initiate Cold-to-Warm Replenishment.`, 'error');
      return NextResponse.json({ success: true, message: 'BSC platform balance updated to low funds.' });
    }

    if (action === 'reset-balance') {
      config.platformBalance = 20000.00;
      await config.save();
      await logBSCDaemonEvent(`[BSC] Platform balance reset to healthy state: ${config.platformBalance} USDT`, 'success');
      return NextResponse.json({ success: true, message: 'BSC platform balance reset to healthy.' });
    }

    if (action === 'clear-logs') {
      await ReplenishmentLogBEP20.deleteMany({});
      await DaemonLogBEP20.deleteMany({});
      config.platformBalance = 10240.50;
      await config.save();
      await DaemonLogBEP20.create({ message: '[BSC] System environment reset. All BSC logs cleared.', type: 'info' });
      await DaemonLogBEP20.create({ message: '[BSC] Status Alert: LOW_FUNDS. Action Required: Initiate Replenishment.', type: 'error' });
      return NextResponse.json({ success: true, message: 'BSC environment reset completed.' });
    }

    return NextResponse.json({ success: false, error: `Invalid action: ${action}` }, { status: 400 });
  } catch (error: any) {
    console.error('[BSC] Error in simulate-daemon API:', error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
