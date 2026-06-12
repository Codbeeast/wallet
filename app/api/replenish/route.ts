import { NextResponse } from 'next/server';
import dbConnect from '@/lib/db';
import ReplenishmentLog from '@/models/ReplenishmentLog';
import { getSystemConfig } from '@/lib/config';

export async function POST(request: Request) {
  try {
    await dbConnect();
    
    // Read the request body
    const body = await request.json();
    const { txHash, amount, fromAddress } = body;
    
    // 1. Basic validation
    if (!txHash || typeof txHash !== 'string' || txHash.trim().length !== 66 && txHash.trim().length !== 64) {
      return NextResponse.json(
        { success: false, error: 'Invalid TRON transaction hash format (must be 64 or 66 chars hex).' },
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
    
    // Scale amount to Sun (6 decimals for TRON/USDT)
    const amountSun = Math.round(parsedAmount * 1_000_000);
    
    const config = await getSystemConfig();
    const toAddress = config.warmWalletAddress;
    
    // 2. Pre-check: is there already an active lock?
    // This provides a fast-fail check before database inserts.
    const activeLock = await ReplenishmentLog.findOne({ status: 'PROCESSING' });
    if (activeLock) {
      // Create a FAILED log directly to record this rejected attempt
      const rejectedLog = await ReplenishmentLog.create({
        txHash: txHash.trim(),
        amount: amountSun,
        fromAddress: fromAddress || 'Unknown',
        toAddress,
        status: 'FAILED',
        error: 'Concurrent replenishment rejected: Mutex lock is active.',
      }).catch(() => null); // ignore duplicate txHash errors for rejected logs
      
      return NextResponse.json(
        { 
          success: false, 
          error: 'Another replenishment is currently in progress. Mutex lock is active.',
          logId: rejectedLog?._id || null
        },
        { status: 409 }
      );
    }
    
    // 3. Create the log in PENDING status
    let logDoc;
    try {
      logDoc = new ReplenishmentLog({
        txHash: txHash.trim(),
        amount: amountSun,
        fromAddress: fromAddress || 'Unknown',
        toAddress,
        status: 'PENDING',
      });
      await logDoc.save();
    } catch (err: any) {
      // Handle unique constraint on txHash
      if (err.code === 11000 && err.keyPattern?.txHash) {
        return NextResponse.json(
          { success: false, error: 'This transaction hash has already been registered in the system.' },
          { status: 400 }
        );
      }
      throw err;
    }
    
    // 4. Atomically transition PENDING -> PROCESSING to acquire the lock.
    try {
      logDoc.status = 'PROCESSING';
      await logDoc.save();
    } catch (err: any) {
      // If a duplicate key error is thrown here, it means another request transitioned to PROCESSING
      // in the exact millisecond between our pre-check and update.
      if (err.code === 11000 && err.keyPattern?.status) {
        // Update the log we just created to FAILED
        logDoc.status = 'FAILED';
        logDoc.error = 'Distributed mutex lock collision: another process acquired the lock first.';
        await logDoc.save();
        
        return NextResponse.json(
          { 
            success: false, 
            error: 'Mutex lock conflict. Another replenishment request is already running.',
            logId: logDoc._id
          },
          { status: 409 }
        );
      }
      throw err;
    }
    
    return NextResponse.json({
      success: true,
      message: 'Replenishment initiated. Transaction is now in PROCESSING state (Mutex locked).',
      data: {
        id: logDoc._id,
        txHash: logDoc.txHash,
        amount: logDoc.amount / 1_000_000, // standard USDT format for display
        status: logDoc.status,
        createdAt: logDoc.createdAt,
      },
    });
  } catch (error: any) {
    console.error('Error in replenish API route:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Internal Server Error' },
      { status: 500 }
    );
  }
}
