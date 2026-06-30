export default async () => ({
  config: (cfg) => {
    cfg.command = cfg.command ?? {};
    cfg.command["dotagents-plugin-proof"] = {
      description: "Proof command injected by generated OpenCode plugin projection.",
      prompt: "DOTAGENTS_OPENCODE_PLUGIN_EXECUTION_PROOF",
    };
  },
});
