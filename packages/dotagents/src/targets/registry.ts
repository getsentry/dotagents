import type { AgentDefinition } from "./types.js";
import claude from "./definitions/claude.js";
import cursor from "./definitions/cursor.js";
import codex from "./definitions/codex.js";
import vscode from "./definitions/vscode.js";
import opencode from "./definitions/opencode.js";

const ALL_AGENTS: AgentDefinition[] = [claude, cursor, codex, vscode, opencode];
const PLUGIN_ONLY_AGENT_IDS = ["grok"];
const PLUGIN_AGENT_IDS = ["claude", "cursor", "codex", "grok", "opencode"];

const AGENT_REGISTRY = new Map<string, AgentDefinition>(
  ALL_AGENTS.map((a) => [a.id, a]),
);

export function getAgent(id: string): AgentDefinition | undefined {
  return AGENT_REGISTRY.get(id);
}

export function allAgentIds(): string[] {
  return [...AGENT_REGISTRY.keys()];
}

/** Returns agent IDs accepted in agents.toml, including plugin-only targets. */
export function allConfigAgentIds(): string[] {
  return [...new Set([...allAgentIds(), ...PLUGIN_ONLY_AGENT_IDS])];
}

/** Returns runtime IDs that plugin declarations may target. */
export function allPluginAgentIds(): string[] {
  return PLUGIN_AGENT_IDS;
}

export function allAgents(): AgentDefinition[] {
  return ALL_AGENTS;
}
