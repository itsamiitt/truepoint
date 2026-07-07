// @leadwolf/forge-worker — the Forge pipeline DAG (parse→extract→resolve→verify→promote→maintenance) on BullMQ,
// peer to apps/workers (docs/planning/forge/12, re-homed from the truepoint-forge @forge/workers). The promote/
// sync stage writes master_* IN-PROCESS via @leadwolf/db withErTx/forgeSyncRepository (no HTTP push). The full
// register + processors land in P4; this is the boot stub.
console.info("forge-worker: boot stub (processors land in P4)");
