import { NextResponse } from 'next/server';
import dbConnect from '@/lib/db';
import ReplenishmentLogBEP20 from '@/models/ReplenishmentLogBEP20';
import { getBSCSystemConfig } from '@/lib/configBSC';
import { ethers } from 'ethers';

export async function POST(request: Request) {
  try {
    await dbConnect();

    const body = await request.json();
    const { txHash, amount, fromAddress } = body;

    // 1. Validate EVM transaction hash format: 0x + 64 hex chars = 66 chars total
    if (!txHash || typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash.trim())) {
      return NextResponse.json(
        { success: false, error: 'Invalid BSC transaction hash format. Expected 0x followed by 64 hex characters.' },
        { status: 400 }
      );
    }

    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      return NextResponse.json(
        { success: false, error: 'Replenishment amount must be a positive number.' },
        { status: 400 }
      );
    }

    // Convert USDT amount to Wei (18 decimals) as a BigInt string
    const amountWei = ethers.parseUnits(parsedAmount.toString(), 18).toString();

    const config = await getBSCSystemConfig();
    const toAddress = config.warmWalletAddress;

    // 2. Pre-check for active mutex lock
    const activeLock = await ReplenishmentLogBEP20.findOne({ status: 'PROCESSING' });
    if (activeLock) {
      const rejectedLog = await ReplenishmentLogBEP20.create({
        txHash: txHash.trim(),
        amount: amountWei,
        fromAddress: fromAddress || 'Unknown',
        toAddress,
        status: 'FAILED',
        error: 'Concurrent replenishment rejected: Mutex lock is active.',
      }).catch(() => null);

      return NextResponse.json(
        {
          success: false,
          error: 'Another replenishment is currently in progress. Mutex lock is active.',
          logId: rejectedLog?._id || null,
        },
        { status: 409 }
      );
    }

    // 3. Create log in PENDING status
    let logDoc;
    try {
      logDoc = new ReplenishmentLogBEP20({
        txHash: txHash.trim(),
        amount: amountWei,
        fromAddress: fromAddress || 'Unknown',
        toAddress,
        status: 'PENDING',
      });
      await logDoc.save();
    } catch (err: any) {
      if (err.code === 11000 && err.keyPattern?.txHash) {
        return NextResponse.json(
          { success: false, error: 'This transaction hash has already been registered in the system.' },
          { status: 400 }
        );
      }
      throw err;
    }

    // 4. Atomically transition PENDING → PROCESSING to acquire mutex
    try {
      logDoc.status = 'PROCESSING';
      await logDoc.save();
    } catch (err: any) {
      if (err.code === 11000 && err.keyPattern?.status) {
        logDoc.status = 'FAILED';
        logDoc.error = 'Distributed mutex lock collision: another process acquired the lock first.';
        await logDoc.save();

        return NextResponse.json(
          {
            success: false,
            error: 'Mutex lock conflict. Another replenishment request is already running.',
            logId: logDoc._id,
          },
          { status: 409 }
        );
      }
      throw err;
    }

    return NextResponse.json({
      success: true,
      message: 'BSC Replenishment initiated. Transaction is now in PROCESSING state (Mutex locked).',
      data: {
        id: logDoc._id,
        txHash: logDoc.txHash,
        amountUSDT: parsedAmount,
        amountWei: logDoc.amount,
        status: logDoc.status,
        createdAt: logDoc.createdAt,
      },
    });
  } catch (error: any) {
    console.error('[BSC] Error in replenish API route:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Internal Server Error' },
      { status: 500 }
    );
  }
}
