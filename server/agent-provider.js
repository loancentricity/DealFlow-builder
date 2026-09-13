/** Replace only when both a real provider and an isolated execution worker exist. */
export class AgentProvider {
  status() {
    throw new Error("Implement provider status");
  }
  async execute(_task, _eventSink) {
    throw new Error("Implement isolated execution");
  }
}
export class UnavailableAgentProvider extends AgentProvider {
  status() {
    return {
      available: false,
      reason:
        "Agent execution is unavailable. Connect an actual provider and an isolated worker to enable coordinated tasks.",
    };
  }
  async execute() {
    throw Object.assign(new Error(this.status().reason), { status: 503 });
  }
}
