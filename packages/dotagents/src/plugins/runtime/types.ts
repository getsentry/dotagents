export interface PluginWriteWarning {
  agent: string;
  name: string;
  message: string;
}

export interface PluginWriteResult {
  warnings: PluginWriteWarning[];
  written: number;
}

export interface PluginVerifyIssue {
  agent: string;
  name: string;
  issue: string;
}

export interface RuntimeOutput {
  agent: string;
  filePath: string;
  content: string;
}
