import { NextResponse } from 'next/server';
import dbConnect from '@/lib/db';
import DaemonLog from '@/models/DaemonLog';
import ReplenishmentLog from '@/models/ReplenishmentLog';
import { getSystemConfig } from '@/lib/config';
import { logSystemEvent } from '@/lib/logger';

export const dynamic = 'force-dynamic';

// GET: Fetch the latest daemon logs to show in the live console
export async function GET() {
  try {
    await dbConnect();
    const logs = await DaemonLog.find()
      .sort({ createdAt: -1 })
      .limit(40);
      
    // Return logs in chronological order
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

// POST: Trigger simulated daemon events or reset environment
export async function POST(request: Request) {
  try {
    await dbConnect();
    const body = await request.json();
    const { action, txHash } = body;
    
    const config = await getSystemConfig();
    
    if (action === 'confirm') {
      if (!txHash) {
        return NextResponse.json({ success: false, error: 'txHash is required for confirmation.' }, { status: 400 });
      }
      
      const logDoc = await ReplenishmentLog.findOne({ txHash, status: 'PROCESSING' });
      if (!logDoc) {
        return NextResponse.json({ success: false, error: 'No PROCESSING replenishment transaction found for this hash.' }, { status: 404 });
      }
      
      const amountUSDT = logDoc.amount / 1_000_000;
      
      await logSystemEvent(`Daemon intercepted matching Transfer event for txHash: ${txHash.slice(0, 10)}...`, 'info');
      await logSystemEvent(`Verifying on-chain details. Destination: ${logDoc.toAddress}, Amount: ${amountUSDT} USDT`, 'info');
      
      // Update log doc status to SUCCESS
      logDoc.status = 'SUCCESS';
      await logDoc.save();
      await logSystemEvent(`Verification successful. Transaction execution status: SUCCESS. On-chain amount verified.`, 'success');
      
      // Update system config platform balance
      config.platformBalance += amountUSDT;
      await config.save();
      await logSystemEvent(`Platform internal balance sheet updated: +${amountUSDT} USDT. New Balance: ${config.platformBalance} USDT`, 'success');
      await logSystemEvent(`Mutex lock cleanly released. System ready for next replenishment.`, 'success');
      
      return NextResponse.json({
        success: true,
        message: 'Transaction confirmed successfully and platform balance updated.',
      });
    }
    
    if (action === 'trigger-funds-low') {
      config.platformBalance = 10240.50; // set low balance
      await config.save();
      
      await logSystemEvent(`Platform balance updated to low funds state: ${config.platformBalance} USDT (Threshold: ${config.lowFundsThreshold} USDT)`, 'warn');
      await logSystemEvent(`Status Alert: LOW_FUNDS. Action Required: Initiate Cold-to-Warm Replenishment.`, 'error');
      
      return NextResponse.json({ success: true, message: 'Platform balance updated to low funds.' });
    }
    
    if (action === 'reset-balance') {
      config.platformBalance = 20000.00; // set healthy balance
      await config.save();
      
      await logSystemEvent(`Platform balance reset to healthy state: ${config.platformBalance} USDT`, 'success');
      
      return NextResponse.json({ success: true, message: 'Platform balance reset to healthy.' });
    }
    
    if (action === 'clear-logs') {
      // Clear logs
      await ReplenishmentLog.deleteMany({});
      await DaemonLog.deleteMany({});
      
      // Reset config
      config.platformBalance = 10240.50;
      await config.save();
      
      await logSystemEvent('System environment reset. All logs cleared and balance reset to initial state.', 'info');
      await logSystemEvent(`Status Alert: LOW_FUNDS. Action Required: Initiate Cold-to-Warm Replenishment.`, 'error');
      
      return NextResponse.json({ success: true, message: 'System environment reset completed.' });
    }
    
    return NextResponse.json({ success: false, error: `Invalid action: ${action}` }, { status: 400 });
  } catch (error: any) {
    console.error('Error in simulate-daemon API:', error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
