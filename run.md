# Aegis Wallet Gateway — Startup and Testing Guide

This guide provides instructions to run and test both the **TRC-20 (TRON)** and **BEP-20 (BSC)** wallet systems. 

---

## 1. Environment Variable Configuration

All configurations reside in the [.env.local](file:///d:/CareerCraftly/wallet/.env.local) file in the root directory.

### Check or Fill in these variables:
```env
# ==========================================
# BSC Testnet Configuration
# ==========================================
BSC_RPC_URL=https://data-seed-prebsc-1-s1.binance.org:8545/

# BEP-20 Enterprise Wallet Topology (0x EVM hex addresses)
BSC_WARM_WALLET_ADDRESS=0xYourWarmWalletAddress
BSC_COLD_TREASURY_ADDRESS=0xYourColdTreasuryAddress

# BEP-20 USDT Token Address on BSC Testnet
BSC_USDT_CONTRACT_ADDRESS=0x337610d27c682E347C9cD60BD4b3b107C9d34dDd

# Safety Threshold Configuration (in USDT)
BSC_LOW_FUNDS_THRESHOLD=15000

# Turnkey KMS EVM address corresponding to your API key configuration
TURNKEY_BSC_WARM_WALLET_ADDRESS=0xYourWarmWalletFromTurnkey
```

> [!NOTE]
> * **Where to find Turnkey addresses:** Go to [app.turnkey.com](https://app.turnkey.com) → **Wallets** → Your Wallet → under **Accounts**, locate the item with Curve `secp256k1` and Address format `Ethereum`. Use this `0x...` address for `TURNKEY_BSC_WARM_WALLET_ADDRESS`.
> * **BNB Testnet Faucet:** You can acquire free BNB for transaction gas on the BSC Testnet from the [BNB Chain Testnet Faucet](https://testnet.bnbchain.org/faucet-smart).

---

## 2. Running the System

If PowerShell execution policies on Windows block execution of npm script binaries, you should run the fallback direct commands below.

### Command Table:

| Component | Standard Command | Fallback / Windows Direct Command |
| :--- | :--- | :--- |
| **Next.js Web Server** | `npm run dev` | `node node_modules/next/dist/bin/next dev` |
| **BSC Daemon** | `npm run daemon:bsc` | `node node_modules/tsx/dist/cli.mjs daemons/bscDepositListener.ts` |
| **TRON Daemon** | `npm run daemon` | `node node_modules/tsx/dist/cli.mjs daemons/depositListener.ts` |

---

## 3. How to Test the BEP-20 Implementation

### Phase 1: Mock Mode (Zero Setup Needed)
This verifies database states, page logic, and mock sweeps without requiring a browser wallet, real gas, or Turnkey keys.

1. Start your local web server and navigate to **`http://localhost:3000/BEP20`**.
2. Keep the toggle switch at the top-right of the replenishment console set to **MOCK MODE**.
3. **Low Funds Banner Test:**
   * Click **Force Low Funds**. The top alert banner will turn red indicating low funds.
   * Click **Force Healthy**. The banner will return to normal amber.
4. **Mock Replenishment (Deposit):**
   * Enter a USDT amount (e.g. `5000`) and click **Initiate Replenishment**.
   * The panel will show stages: *Connecting -> Preparing -> Signing -> Broadcasting*.
   * Under **BSC Daemon Transfer Event Verification**, click the **Force Verify Now** button.
   * The platform balance card will update by `+5,000` USDT, the mutex lock will release, and a new record will appear in the **Replenishment Audits** ledger.
5. **Mock Sweep (Withdrawal):**
   * Enter a sweep amount (e.g. `2000`) and click **Initiate Sweep to Cold**.
   * The page will execute the 5-stage signature/broadcast flow mock.
   * On success, the platform balance will decrease and logs will update.

---

### Phase 2: Live Mode (On-chain Testing)
This verifies real browser-wallet interactions, on-chain events, and KMS Turnkey signatures on the BSC Testnet.

1. **MetaMask Setup:**
   * Ensure MetaMask is installed in your browser.
   * Click **MM Disconnected** in the top navigation header.
   * The page will request connection and automatically prompt you to add & switch to **BSC Testnet** if it is not configured.
2. **Setup Env.local:**
   * Change `BSC_WARM_WALLET_ADDRESS`, `BSC_COLD_TREASURY_ADDRESS`, and `TURNKEY_BSC_WARM_WALLET_ADDRESS` in `.env.local` to valid Ethereum `0x` addresses.
3. **Start the BSC Daemon:**
   * Run the BSC Daemon script in a separate terminal:
     `node node_modules/tsx/dist/cli.mjs daemons/bscDepositListener.ts`
   * Confirm the console prints: `BSC safety monitoring fully armed. Listening for BEP-20 replenishments...`
4. **Live Replenishment:**
   * Toggle the replenishment console on the page to **LIVE BSC**.
   * Click **Initiate Replenishment**.
   * MetaMask will open. Confirm the contract transfer transaction.
   * Once MetaMask broadcasts the tx and the block registers, the frontend will lock the mutex queue and set status to `PROCESSING`.
   * The background daemon will automatically detect the transfer event on-chain, verify target/amounts, release the database lock, and update the balance.
5. **Live Sweep:**
   * Enter an amount and click **Initiate Sweep to Cold**.
   * The backend will load your Turnkey KMS key, construct the raw EVM transfer call, sign it via Turnkey, and broadcast it to the BSC Testnet RPC.

---

## 4. Troubleshooting

* **`⨯ Another next dev server is already running` / Port 3000 In Use:**
  Run `taskkill /PID <PID_NUMBER> /F` in cmd or PowerShell to kill the background node server using the port, or use:
  ```powershell
  Stop-Process -Id <PID_NUMBER> -Force
  ```
* **`network does not support ENS` error in console logs:**
  This is expected when `BSC_WARM_WALLET_ADDRESS` is still set to the placeholder string `0xYourWarmWalletAddress`. Ethers.js treats invalid addresses as ENS domain names and tries to resolve them. It will disappear as soon as you populate a valid `0x` 40-character hex address.
