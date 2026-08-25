const EPOCH = 1704067200000n;
const MACHINE_BITS = 10n;
const SEQUENCE_BITS = 12n;
const MAX_SEQUENCE = (1n << SEQUENCE_BITS) - 1n;
const MACHINE_ID =
  BigInt(process.env.MACHINE_ID ?? '0') & ((1n << MACHINE_BITS) - 1n);

let sequence = 0n;
let lastTimestamp = -1n;

export function generateSnowflakeId(): string {
  let ts = BigInt(Date.now());
  if (ts === lastTimestamp) {
    sequence = (sequence + 1n) & MAX_SEQUENCE;
    if (sequence === 0n) {
      while (ts <= lastTimestamp) ts = BigInt(Date.now());
    }
  } else {
    sequence = 0n;
  }
  lastTimestamp = ts;
  return (
    ((ts - EPOCH) << (MACHINE_BITS + SEQUENCE_BITS)) |
    (MACHINE_ID << SEQUENCE_BITS) |
    sequence
  ).toString();
}
