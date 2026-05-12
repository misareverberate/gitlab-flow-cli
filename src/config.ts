import { confirm, input, password } from "@inquirer/prompts";
import dotenv from "dotenv";
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type RuntimeConfig = {
  gitlabBaseUrl: string;
  gitlabProjectPath: string;
  gitlabToken: string;
  defaultTargetBranch: string;
  reviewLabel: string;
  doingLabel: string;
  doneLabel: string;
};

type StoredConfig = Partial<RuntimeConfig> & {
  hasSeenWelcome?: boolean;
};

const DEFAULT_CONFIG = {
  gitlabBaseUrl: "https://git.inteli.edu.br",
  gitlabProjectPath: "graduacao/2026-1b/t24/g05",
  defaultTargetBranch: "main",
  reviewLabel: "review",
  doingLabel: "doing",
  doneLabel: "done"
} satisfies Omit<RuntimeConfig, "gitlabToken">;

const CONFIG_DIR = path.join(homedir(), ".gl-work");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const STATE_DIR = path.join(CONFIG_DIR, "state");

const clean = (value?: string) => value?.trim() || undefined;

const envValue = (name: keyof NodeJS.ProcessEnv) => clean(process.env[name]);

export function loadEnv(importMetaUrl: string) {
  dotenv.config({
    path: path.resolve(process.cwd(), ".env")
  });

  const __filename = fileURLToPath(importMetaUrl);
  const __dirname = path.dirname(__filename);

  dotenv.config({
    path: path.resolve(__dirname, "../.env"),
    override: false
  });
}

export function getProjectStateFile() {
  const projectKey = createHash("sha256").update(process.cwd()).digest("hex").slice(0, 16);
  return path.join(STATE_DIR, `${projectKey}.json`);
}

async function readStoredConfig(): Promise<StoredConfig> {
  if (!existsSync(CONFIG_FILE)) return {};

  const raw = await readFile(CONFIG_FILE, "utf8");
  return JSON.parse(raw) as StoredConfig;
}

async function writeStoredConfig(config: StoredConfig) {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await writeFile(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(CONFIG_FILE, 0o600);
}

export async function writeProjectStateFile(contents: string) {
  await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  const stateFile = getProjectStateFile();
  await writeFile(stateFile, contents, { mode: 0o600 });
  await chmod(stateFile, 0o600);
}

export async function readProjectStateFile() {
  const stateFile = getProjectStateFile();
  if (!existsSync(stateFile)) return null;
  return readFile(stateFile, "utf8");
}

export async function clearProjectStateFile() {
  const stateFile = getProjectStateFile();
  if (!existsSync(stateFile)) return;
  await unlink(stateFile);
}

function resolveConfig(stored: StoredConfig): RuntimeConfig {
  return {
    gitlabBaseUrl: envValue("GITLAB_BASE_URL") ?? stored.gitlabBaseUrl ?? DEFAULT_CONFIG.gitlabBaseUrl,
    gitlabProjectPath: envValue("GITLAB_PROJECT_PATH") ?? stored.gitlabProjectPath ?? DEFAULT_CONFIG.gitlabProjectPath,
    gitlabToken: envValue("GITLAB_TOKEN") ?? stored.gitlabToken ?? "",
    defaultTargetBranch: envValue("DEFAULT_TARGET_BRANCH") ?? stored.defaultTargetBranch ?? DEFAULT_CONFIG.defaultTargetBranch,
    reviewLabel: envValue("REVIEW_LABEL") ?? stored.reviewLabel ?? DEFAULT_CONFIG.reviewLabel,
    doingLabel: envValue("DOING_LABEL") ?? stored.doingLabel ?? DEFAULT_CONFIG.doingLabel,
    doneLabel: envValue("DONE_LABEL") ?? stored.doneLabel ?? DEFAULT_CONFIG.doneLabel
  };
}

function printWelcome() {
  console.log("");
  console.log("Bem-vindo ao gl-work.");
  console.log("Essa CLI foi criada por Matheus para agilizar o fluxo com GitLab.");
  console.log("Se ela te ajudar, aceito uma doacao solidaria de 1 real :).");
  console.log("");
}

async function promptForConfig(stored: StoredConfig, showWelcome: boolean): Promise<StoredConfig> {
  if (showWelcome) printWelcome();

  const resolved = resolveConfig(stored);

  let gitlabToken = stored.gitlabToken ?? "";
  if (!gitlabToken) {
    gitlabToken = await password({
      message: "Seu token pessoal do GitLab",
      validate: (value) => value.trim() ? true : "Informe um token válido."
    });
  } else {
    const shouldUpdateToken = await confirm({
      message: "Deseja atualizar o token salvo?",
      default: false
    });

    if (shouldUpdateToken) {
      gitlabToken = await password({
        message: "Novo token pessoal do GitLab",
        validate: (value) => value.trim() ? true : "Informe um token válido."
      });
    }
  }

  const gitlabBaseUrl = await input({
    message: "URL base do GitLab",
    default: resolved.gitlabBaseUrl,
    validate: (value) => value.trim() ? true : "Informe a URL do GitLab."
  });

  const gitlabProjectPath = await input({
    message: "Path do projeto no GitLab",
    default: resolved.gitlabProjectPath,
    validate: (value) => value.trim() ? true : "Informe o path do projeto."
  });

  const defaultTargetBranch = await input({
    message: "Branch alvo padrao dos MRs",
    default: resolved.defaultTargetBranch,
    validate: (value) => value.trim() ? true : "Informe a branch alvo."
  });

  const reviewLabel = await input({
    message: "Label usada quando o issue vai para review",
    default: resolved.reviewLabel,
    validate: (value) => value.trim() ? true : "Informe a label de review."
  });

  const doingLabel = await input({
    message: "Label usada quando o issue esta em doing",
    default: resolved.doingLabel,
    validate: (value) => value.trim() ? true : "Informe a label de doing."
  });

  const doneLabel = await input({
    message: "Label usada quando o issue foi concluido",
    default: resolved.doneLabel,
    validate: (value) => value.trim() ? true : "Informe a label de concluido."
  });

  return {
    hasSeenWelcome: true,
    gitlabToken: gitlabToken.trim(),
    gitlabBaseUrl: gitlabBaseUrl.trim(),
    gitlabProjectPath: gitlabProjectPath.trim(),
    defaultTargetBranch: defaultTargetBranch.trim(),
    reviewLabel: reviewLabel.trim(),
    doingLabel: doingLabel.trim(),
    doneLabel: doneLabel.trim()
  };
}

export async function ensureRuntimeConfig(): Promise<RuntimeConfig> {
  const stored = await readStoredConfig();
  const firstRun = !stored.hasSeenWelcome;

  if (firstRun || !resolveConfig(stored).gitlabToken) {
    const updated = await promptForConfig(stored, firstRun);
    await writeStoredConfig(updated);
    return resolveConfig(updated);
  }

  return resolveConfig(stored);
}

export async function configureCli() {
  const stored = await readStoredConfig();
  const updated = await promptForConfig(stored, false);
  await writeStoredConfig(updated);

  console.log("");
  console.log(`Configuracao salva em ${CONFIG_FILE}`);
}
