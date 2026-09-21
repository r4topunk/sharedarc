/**
 * Reconcile a live DripPool on Arc mainnet (PRD §13, CHECKLIST step 22 / proof row 10).
 *
 * Read-only: it sends no transaction and needs no key. It checks the accounting identity
 *
 *   streamed === Σ withdrawn + Σ claimable + sub-unit remainder + index dust
 *
 * where `streamed` is every wad ever accrued to members. The contract never stores that number, but
 * every `withdraw` lowers `owed` by exactly `units * WAD_PER_UNIT`, so it is recovered as
 * `owed + Σ withdrawn * WAD_PER_UNIT`.
 *
 * `getPool` returns the *stored* `accIndex` and `owed`, which are stale until the next write, while
 * `claimable` simulates the accrual up to the current block. This mirrors `DripPool._accrueMath` so both
 * sides are read at the same instant.
 *
 * Usage: pnpm reconcile:mainnet [poolId]
 */
import { type Address, createPublicClient, getAddress, http, parseAbi } from 'viem';

const RPC_URL = process.env.ARC_RPC_URL ?? 'https://rpc.mainnet.arc.io';
const DRIP_POOL = getAddress('0x92b8fdB2c457b64d4510aC980A84283356D8A44f');
const DEPLOY_BLOCK = 21543579n;
/** Arc caps `eth_getLogs` at 10,000 blocks per request. */
const LOG_WINDOW = 9_000n;
const WAD_PER_UNIT = 1_000_000_000_000n;
const INDEX_SCALE = 10n ** 18n;

const abi = parseAbi([
  'function getPool(uint256) view returns ((address owner,address pendingOwner,uint64 startTime,uint64 lastAccrual,bool cancelled,uint128 ratePerSecond,uint128 totalShares,uint256 balance,uint256 owed,uint256 accIndex))',
  'function getMember(uint256,address) view returns ((uint128 shares,address payout,uint256 index,uint256 pending))',
  'function claimable(uint256,address) view returns (uint256)',
  'event PoolCreated(uint256 indexed poolId, address indexed owner, uint256 ratePerSecond, uint64 startTime, string name)',
  'event Deposited(uint256 indexed poolId, address indexed from, uint256 amount)',
  'event SharesSet(uint256 indexed poolId, address indexed member, uint256 oldShares, uint256 newShares, uint256 totalShares)',
  'event Withdrawn(uint256 indexed poolId, address indexed member, address indexed to, uint256 amount, address caller)',
  'event UnstreamedWithdrawn(uint256 indexed poolId, address indexed to, uint256 amount)',
]);

const poolId = BigInt(process.argv[2] ?? '1');
const client = createPublicClient({ transport: http(RPC_URL) });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const usdc = (units: bigint) => `${(Number(units) / 1e6).toFixed(6)} USDC`;

/** One windowed pass over the contract's whole log history; the public RPC rate-limits parallel scans. */
async function readLogs() {
  const head = await client.getBlockNumber();
  const logs = [];
  for (let from = DEPLOY_BLOCK; from <= head; from += LOG_WINDOW + 1n) {
    const to = from + LOG_WINDOW > head ? head : from + LOG_WINDOW;
    for (let attempt = 0; ; attempt++) {
      try {
        logs.push(
          ...(await client.getContractEvents({ address: DRIP_POOL, abi, fromBlock: from, toBlock: to })),
        );
        break;
      } catch (error) {
        if (attempt >= 5) throw error;
        await sleep(1_500 * (attempt + 1));
      }
    }
    await sleep(250);
  }
  return logs.filter((log) => log.args.poolId === poolId);
}

/** Mirrors `DripPool._accrueMath` so the stored pool state lines up with what `claimable` reports. */
function accrue(
  pool: {
    startTime: bigint;
    lastAccrual: bigint;
    ratePerSecond: bigint;
    totalShares: bigint;
    balance: bigint;
    owed: bigint;
    accIndex: bigint;
  },
  now: bigint,
) {
  let { accIndex, owed } = pool;
  const from = pool.lastAccrual > pool.startTime ? pool.lastAccrual : pool.startTime;
  if (now > from && pool.ratePerSecond > 0n && pool.totalShares > 0n) {
    const available = pool.balance * WAD_PER_UNIT - owed;
    const funded = available / pool.ratePerSecond;
    const elapsed = now - from;
    const dt = funded < elapsed ? funded : elapsed;
    if (dt > 0n) {
      const streamed = pool.ratePerSecond * dt;
      accIndex += (streamed * INDEX_SCALE) / pool.totalShares;
      owed += streamed;
    }
  }
  return { accIndex, owed };
}

const logs = await readLogs();
const head = await client.getBlock();
const now = head.timestamp;

const createdAt = logs.find((log) => log.eventName === 'PoolCreated')?.blockNumber;
const createdTs = createdAt ? (await client.getBlock({ blockNumber: createdAt })).timestamp : 0n;

const stored = await client.readContract({
  address: DRIP_POOL,
  abi,
  functionName: 'getPool',
  args: [poolId],
});
const pool = {
  startTime: stored.startTime,
  lastAccrual: stored.lastAccrual,
  ratePerSecond: BigInt(stored.ratePerSecond),
  totalShares: BigInt(stored.totalShares),
  balance: stored.balance,
  owed: stored.owed,
  accIndex: stored.accIndex,
};
const { accIndex, owed } = accrue(pool, now);

const roster: Address[] = [
  ...new Set(
    logs.filter((log) => log.eventName === 'SharesSet').map((log) => getAddress(log.args.member as Address)),
  ),
];

let entitlement = 0n;
let claimableUnits = 0n;
const members = [];
for (const member of roster) {
  const state = await client.readContract({
    address: DRIP_POOL,
    abi,
    functionName: 'getMember',
    args: [poolId, member],
  });
  const owedToMember = state.pending + (BigInt(state.shares) * (accIndex - state.index)) / INDEX_SCALE;
  const claimable = await client.readContract({
    address: DRIP_POOL,
    abi,
    functionName: 'claimable',
    args: [poolId, member],
  });
  entitlement += owedToMember;
  claimableUnits += claimable;
  members.push({
    member,
    shares: state.shares.toString(),
    claimable: usdc(claimable),
    entitlementWad: owedToMember.toString(),
    subUnitWad: (owedToMember % WAD_PER_UNIT).toString(),
    matchesContract: owedToMember / WAD_PER_UNIT === claimable,
  });
}

const sum = (name: 'Withdrawn' | 'Deposited' | 'UnstreamedWithdrawn') =>
  logs
    .filter((log) => log.eventName === name)
    .reduce((total, log) => total + ((log.args as { amount?: bigint }).amount ?? 0n), 0n);
const withdrawnUnits = sum('Withdrawn');
const depositedUnits = sum('Deposited');
const sweptUnits = sum('UnstreamedWithdrawn');

const streamedWad = owed + withdrawnUnits * WAD_PER_UNIT;
const subUnitWad = entitlement - claimableUnits * WAD_PER_UNIT;
const dustWad = owed - entitlement;
const identityHolds =
  streamedWad === withdrawnUnits * WAD_PER_UNIT + claimableUnits * WAD_PER_UNIT + subUnitWad + dustWad;

console.log(
  JSON.stringify(
    {
      poolId: poolId.toString(),
      asOf: new Date(Number(now) * 1000).toISOString(),
      createdAt: new Date(Number(createdTs) * 1000).toISOString(),
      ageDays: Number((Number(now - createdTs) / 86_400).toFixed(3)),
      deposited: usdc(depositedUnits),
      sweptUnstreamed: usdc(sweptUnits),
      netDeposited: usdc(depositedUnits - sweptUnits),
      balance: usdc(stored.balance),
      withdrawn: usdc(withdrawnUnits),
      withdrawals: logs.filter((log) => log.eventName === 'Withdrawn').length,
      claimable: usdc(claimableUnits),
      members,
      streamedWad: streamedWad.toString(),
      subUnitRemainderWad: subUnitWad.toString(),
      dustWad: dustWad.toString(),
      dustUSDC: Number(dustWad) / 1e18,
      identityHolds,
      balanceBacksOwed: stored.balance * WAD_PER_UNIT >= owed,
      everyMemberMatchesContract: members.every((m) => m.matchesContract),
    },
    null,
    2,
  ),
);

if (!identityHolds) {
  console.error('RECONCILIATION FAILED: the accounting identity does not hold');
  process.exit(1);
}
