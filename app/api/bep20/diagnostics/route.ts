import { NextResponse } from 'next/server';
import { Turnkey } from '@turnkey/sdk-server';
import { getBSCProvider } from '@/lib/bsc';

export async function GET() {
  const results: Record<string, { ok: boolean; message: string; value?: string }> = {};

  // ─── 1. ENV VAR PRESENCE ──────────────────────────────────────────────────
  const envChecks: Record<string, string | undefined> = {
    BSC_RPC_URL:                   process.env.BSC_RPC_URL,
    BSC_WARM_WALLET_ADDRESS:       process.env.BSC_WARM_WALLET_ADDRESS,
    BSC_COLD_TREASURY_ADDRESS:     process.env.BSC_COLD_TREASURY_ADDRESS,
    BSC_USDT_CONTRACT_ADDRESS:     process.env.BSC_USDT_CONTRACT_ADDRESS,
    TURNKEY_API_BASE_URL:          process.env.TURNKEY_API_BASE_URL,
    TURNKEY_API_PUBLIC_KEY:        process.env.TURNKEY_API_PUBLIC_KEY,
    TURNKEY_API_PRIVATE_KEY:       process.env.TURNKEY_API_PRIVATE_KEY,
    TURNKEY_ORGANIZATION_ID:       process.env.TURNKEY_ORGANIZATION_ID,
    TURNKEY_BSC_WARM_WALLET_ADDRESS: process.env.TURNKEY_BSC_WARM_WALLET_ADDRESS,
  };

  for (const [key, val] of Object.entries(envChecks)) {
    const isPlaceholder = !val ||
      val.includes('YourWarm') ||
      val.includes('YourCold') ||
      val.includes('YourTurnkey') ||
      val.trim() === '';

    results[`env.${key}`] = {
      ok: !isPlaceholder,
      message: isPlaceholder
        ? `Missing or still set to placeholder`
        : `Set`,
      // Redact sensitive keys – show only first 6 and last 4 chars
      value: key.includes('PRIVATE') || key.includes('PUBLIC')
        ? val ? `${val.slice(0, 6)}...${val.slice(-4)}` : '—'
        : val ?? '—',
    };
  }

  // ─── 2. TURNKEY API PRIVATE KEY LENGTH ───────────────────────────────────
  let rawKey = (process.env.TURNKEY_API_PRIVATE_KEY ?? '')
    .replace(/^0x/, '')
    .replace(/\s+/g, '');
  if (rawKey.length === 66 && rawKey.startsWith('00')) rawKey = rawKey.slice(2);

  results['turnkey.privateKeyLength'] = {
    ok: rawKey.length === 64,
    message: rawKey.length === 64
      ? `Valid 64-char P-256 scalar`
      : `Invalid length: ${rawKey.length} chars (expected 64)`,
    value: `${rawKey.length} chars`,
  };

  // ─── 3. TURNKEY WALLET OWNERSHIP CHECK ───────────────────────────────────
  const turnkeyAddress = process.env.TURNKEY_BSC_WARM_WALLET_ADDRESS;
  try {
    if (rawKey.length !== 64 || !process.env.TURNKEY_API_PUBLIC_KEY || !process.env.TURNKEY_ORGANIZATION_ID) {
      results['turnkey.walletOwnership'] = {
        ok: false,
        message: 'Skipped — Turnkey credentials incomplete',
      };
    } else {
      const turnkey = new Turnkey({
        apiBaseUrl: process.env.TURNKEY_API_BASE_URL || 'https://api.turnkey.com',
        apiPrivateKey: rawKey,
        apiPublicKey: process.env.TURNKEY_API_PUBLIC_KEY!,
        defaultOrganizationId: process.env.TURNKEY_ORGANIZATION_ID!,
      });
      const client = turnkey.apiClient();

      // Fetch wallets — a valid response confirms the API key pair works
      const walletsResp = await client.getWallets({
        organizationId: process.env.TURNKEY_ORGANIZATION_ID!,
      });

      const walletNames = (walletsResp.wallets ?? []).map((w: any) => w.walletName).join(', ');

      // Check if the configured address is owned by the org
      let addressOwned = false;
      for (const wallet of walletsResp.wallets ?? []) {
        const accountsResp = await client.getWalletAccounts({
          organizationId: process.env.TURNKEY_ORGANIZATION_ID!,
          walletId: wallet.walletId,
        });
        const found = (accountsResp.accounts ?? []).some(
          (a: any) => a.address?.toLowerCase() === turnkeyAddress?.toLowerCase()
        );
        if (found) { addressOwned = true; break; }
      }

      results['turnkey.apiAuth'] = {
        ok: true,
        message: `Authenticated. Wallets found: [${walletNames || 'none'}]`,
        value: walletNames || 'none',
      };

      results['turnkey.walletOwnership'] = {
        ok: addressOwned,
        message: addressOwned
          ? `TURNKEY_BSC_WARM_WALLET_ADDRESS is owned by this Turnkey org`
          : `TURNKEY_BSC_WARM_WALLET_ADDRESS NOT found in any wallet — check the address`,
        value: turnkeyAddress ?? '—',
      };
    }
  } catch (err: any) {
    results['turnkey.apiAuth'] = {
      ok: false,
      message: `Turnkey API call failed: ${err.message || err}`,
    };
    results['turnkey.walletOwnership'] = {
      ok: false,
      message: 'Skipped — API auth failed',
    };
  }

  // ─── 4. BSC RPC CONNECTIVITY ──────────────────────────────────────────────
  try {
    const provider = getBSCProvider();
    const network = await provider.getNetwork();
    const blockNumber = await provider.getBlockNumber();
    const isCorrectChain = Number(network.chainId) === 56; // BSC Mainnet

    results['bsc.rpcConnectivity'] = {
      ok: isCorrectChain,
      message: isCorrectChain
        ? `Connected to BSC Mainnet (chainId: ${network.chainId})`
        : `Wrong chainId: ${network.chainId} — expected 56 (BSC Mainnet)`,
      value: `Block #${blockNumber}`,
    };
  } catch (err: any) {
    results['bsc.rpcConnectivity'] = {
      ok: false,
      message: `BSC RPC unreachable: ${err.message || err}`,
    };
  }

  // ─── 5. WARM WALLET ADDRESS FORMAT CHECK ─────────────────────────────────
  const warmAddr = process.env.BSC_WARM_WALLET_ADDRESS ?? '';
  const isValidEVMAddress = /^0x[0-9a-fA-F]{40}$/.test(warmAddr);
  const isPlaceholder = warmAddr.toLowerCase().includes('your');

  results['bsc.warmWalletFormat'] = {
    ok: isValidEVMAddress && !isPlaceholder,
    message: isPlaceholder
      ? 'BSC_WARM_WALLET_ADDRESS is still a placeholder — set your MetaMask address'
      : isValidEVMAddress
        ? 'Valid EVM address format'
        : 'Invalid EVM address format (must be 0x + 40 hex chars)',
    value: warmAddr,
  };

  // ─── 6. TURNKEY vs WARM WALLET MATCH CHECK ────────────────────────────────
  const turnkeyBscAddr = (process.env.TURNKEY_BSC_WARM_WALLET_ADDRESS ?? '').toLowerCase();
  const bscWarmAddr    = (process.env.BSC_WARM_WALLET_ADDRESS ?? '').toLowerCase();
  const areSameAddress = !!(turnkeyBscAddr && bscWarmAddr && turnkeyBscAddr === bscWarmAddr);

  results['bsc.warmVsTurnkeyMatch'] = {
    ok: areSameAddress,
    message: areSameAddress
      ? 'Correct — BSC_WARM_WALLET_ADDRESS matches TURNKEY_BSC_WARM_WALLET_ADDRESS'
      : 'ERROR: BSC_WARM_WALLET_ADDRESS must match TURNKEY_BSC_WARM_WALLET_ADDRESS so Turnkey can sign sweeps from the warm wallet',
  };

  // ─── Summary ──────────────────────────────────────────────────────────────
  const allPassed = Object.values(results).every((r) => r.ok);
  const failCount = Object.values(results).filter((r) => !r.ok).length;

  return NextResponse.json({
    success: true,
    summary: {
      allPassed,
      failCount,
      totalChecks: Object.keys(results).length,
      status: allPassed ? 'ALL_SYSTEMS_GO' : `${failCount}_CHECKS_FAILED`,
    },
    checks: results,
  });
}
