export function deploymentStatus(worker: string, room: string | null, budget: string | null) {
  return { worker_version: worker, room_version: room, budget_version: budget, ready: room === worker && budget === worker };
}
