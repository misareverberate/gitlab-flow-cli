#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { checkbox, input, select, confirm, editor } from "@inquirer/prompts";
import { execa } from "execa";
import { GitLabClient, GitLabLabel, GitLabMember, GitLabMilestone } from "./gitlab.js";
import {
  configureCli,
  ensureRuntimeConfig,
  loadEnv,
  readProjectStateFile,
  RuntimeConfig,
  writeProjectStateFile
} from "./config.js";

loadEnv(import.meta.url);

const TYPES = ["feat", "fix", "docs", "style", "refactor", "test", "chore"];

class FlowCancelled extends Error {
  constructor() {
    super("Fluxo cancelado.");
  }
}

type FlowState = {
  issueIid: number;
  issueUrl: string;
  type: string;
  title: string;
  branch: string;
  labels: string[];
  reviewerId?: number;
  reviewerName?: string;
};

type StartDraft = {
  type: string;
  title: string;
  description: string;
  labels: string[];
  assigneeId: number;
  milestoneId: number;
  reviewerId: number;
};

type MrDraft = {
  reviewerId: number;
  extraDescription: string;
  targetBranch: string;
};

const slugify = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

async function git(args: string[]) {
  return execa("git", args, { stdio: "inherit" });
}

async function gitOutput(args: string[]) {
  return (await execa("git", args)).stdout.trim();
}

async function gitOk(args: string[]) {
  const result = await execa("git", args, { reject: false });
  return result.exitCode === 0;
}

async function ensureGitRepository() {
  const isInsideGitRepo = await gitOk(["rev-parse", "--is-inside-work-tree"]);
  if (!isInsideGitRepo) throw new Error("Este comando precisa ser executado dentro de um repositório Git.");
}

async function hasOriginRemote() {
  return gitOk(["remote", "get-url", "origin"]);
}

async function currentBranch() {
  return gitOutput(["branch", "--show-current"]);
}

async function workingTreeStatus() {
  return gitOutput(["status", "--porcelain"]);
}

async function ensureOriginRemote() {
  if (await hasOriginRemote()) return;
  throw new Error("Remote origin não encontrado. Configure o origin antes de usar este fluxo.");
}

async function confirmDirtyWorkingTree() {
  const status = await workingTreeStatus();
  if (!status) return;

  const shouldContinue = await confirm({
    message: "Existem mudanças locais não commitadas. Continuar mesmo assim?",
    default: false
  });
  if (!shouldContinue) throw new FlowCancelled();
}

async function branchExists(branch: string) {
  const hasLocalBranch = await gitOk(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  const hasFetchedRemoteBranch = await gitOk(["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`]);
  return hasLocalBranch || hasFetchedRemoteBranch;
}

function labelChoices(labels: GitLabLabel[], preselected: string[] = []) {
  return labels.map((label) => ({
    name: label.description ? `${label.name} — ${label.description}` : label.name,
    value: label.name,
    checked: preselected.includes(label.name)
  }));
}

function memberChoices(members: GitLabMember[], includeNobody = false) {
  const choices = members.map((m) => ({ name: `${m.name} (@${m.username})`, value: m.id }));
  return includeNobody ? [{ name: "Ninguém", value: 0 }, ...choices] : choices;
}

function preferredMemberOrder(members: GitLabMember[], preferredMemberId?: number) {
  if (!preferredMemberId) return members;
  const preferred = members.find((member) => member.id === preferredMemberId);
  if (!preferred) return members;
  return [preferred, ...members.filter((member) => member.id !== preferredMemberId)];
}

function milestoneChoices(milestones: GitLabMilestone[]) {
  return [{ name: "Nenhum", value: 0 }, ...milestones.map((m) => ({ name: m.title, value: m.id }))];
}

async function multilineInput(message: string, current = "") {
  console.log(`? ${message}`);
  console.log("  Digite quantas linhas quiser. Para finalizar, envie uma linha contendo apenas .");
  if (current) {
    console.log("  Texto atual:");
    console.log(current.split("\n").map((line) => `  ${line}`).join("\n"));
    console.log("  Novo texto:");
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout
  });
  const lines: string[] = [];

  try {
    while (true) {
      const line = await rl.question("> ");
      if (line.trim() === ".") break;
      lines.push(line);
    }
  } finally {
    rl.close();
  }

  return lines.join("\n").trim();
}

async function longTextInput(message: string, current = "") {
  const mode = await select({
    message,
    choices: [
      { name: "Abrir editor completo", value: "editor" },
      { name: "Digitar ou colar no terminal", value: "terminal" },
      ...(current ? [{ name: "Manter texto atual", value: "keep" }] : [])
    ]
  });

  if (mode === "keep") return current;
  if (mode === "editor") {
    return (await editor({
      message,
      default: current
    })).trim();
  }

  return multilineInput(message, current);
}

function memberName(members: GitLabMember[], memberId: number) {
  if (!memberId) return "Ninguém";
  const member = members.find((m) => m.id === memberId);
  return member ? `${member.name} (@${member.username})` : String(memberId);
}

function milestoneName(milestones: GitLabMilestone[], milestoneId: number) {
  if (!milestoneId) return "Nenhum";
  return milestones.find((m) => m.id === milestoneId)?.title ?? String(milestoneId);
}

function descriptionPreview(description: string) {
  if (!description.trim()) return "vazia";
  const firstLine = description.trim().split("\n")[0];
  return description.includes("\n") ? `${firstLine}...` : firstLine;
}

function printStartDraft(draft: StartDraft, members: GitLabMember[], milestones: GitLabMilestone[]) {
  console.log("\nResumo do issue:");
  console.log(`Tipo: ${draft.type}`);
  console.log(`Título: ${draft.title}`);
  console.log(`Descrição: ${descriptionPreview(draft.description)}`);
  console.log(`Labels: ${draft.labels.join(", ") || "nenhuma"}`);
  console.log(`Responsável: ${memberName(members, draft.assigneeId)}`);
  console.log(`Milestone: ${milestoneName(milestones, draft.milestoneId)}`);
  console.log(`Reviewer: ${memberName(members, draft.reviewerId)}`);
}

function printMrDraft(draft: MrDraft, members: GitLabMember[]) {
  console.log("\nResumo da MR:");
  console.log(`Reviewer: ${memberName(members, draft.reviewerId)}`);
  console.log(`Descrição adicional: ${descriptionPreview(draft.extraDescription)}`);
  console.log(`Branch alvo: ${draft.targetBranch}`);
}

function todayDate() {
  return new Date().toLocaleDateString("en-CA");
}

async function saveState(state: FlowState) {
  await writeProjectStateFile(`${JSON.stringify(state, null, 2)}\n`);
}

async function loadState(): Promise<FlowState | null> {
  const contents = await readProjectStateFile();
  if (!contents) return null;
  return JSON.parse(contents) as FlowState;
}

function createGitLabClient(config: RuntimeConfig) {
  return new GitLabClient({
    baseUrl: config.gitlabBaseUrl,
    token: config.gitlabToken,
    projectPath: config.gitlabProjectPath
  });
}

async function promptIssueType(current?: string) {
  return select({
    message: "Tipo do commit/MR",
    choices: TYPES.map((v) => ({ name: v, value: v })),
    default: current
  });
}

async function promptIssueTitle(current = "") {
  return input({
    message: "Título do issue",
    default: current,
    validate: (value) => value.trim() ? true : "Informe o título do issue."
  });
}

async function promptStartDraft(inputData: {
  labels: GitLabLabel[];
  members: GitLabMember[];
  milestones: GitLabMilestone[];
  currentUserId: number;
  doingLabel: string;
}) {
  const membersWithCurrentFirst = preferredMemberOrder(inputData.members, inputData.currentUserId);
  const draft: StartDraft = {
    type: await promptIssueType(),
    title: await promptIssueTitle(),
    description: await longTextInput("Descrição do issue"),
    labels: [],
    assigneeId: 0,
    milestoneId: 0,
    reviewerId: 0
  };

  draft.labels = await checkbox({
    message: "Selecione TODAS as labels do issue",
    choices: labelChoices(inputData.labels, [inputData.doingLabel])
  });

  draft.assigneeId = await select({
    message: "Responsável pelo issue",
    choices: [...memberChoices(membersWithCurrentFirst), { name: "Ninguém", value: 0 }]
  });

  draft.milestoneId = await select({
    message: "Milestone do issue",
    choices: milestoneChoices(inputData.milestones)
  });

  draft.reviewerId = await select({
    message: "Pessoa que vai revisar o MR",
    choices: memberChoices(inputData.members)
  });

  while (true) {
    printStartDraft(draft, inputData.members, inputData.milestones);
    const action = await select({
      message: "Está tudo certo?",
      choices: [
        { name: "Criar issue e branch", value: "confirm" },
        { name: "Corrigir tipo", value: "type" },
        { name: "Corrigir título", value: "title" },
        { name: "Corrigir descrição", value: "description" },
        { name: "Corrigir labels", value: "labels" },
        { name: "Corrigir responsável", value: "assignee" },
        { name: "Corrigir milestone", value: "milestone" },
        { name: "Corrigir reviewer", value: "reviewer" },
        { name: "Cancelar fluxo", value: "cancel" }
      ]
    });

    if (action === "confirm") return draft;
    if (action === "cancel") throw new FlowCancelled();
    if (action === "type") draft.type = await promptIssueType(draft.type);
    if (action === "title") draft.title = await promptIssueTitle(draft.title);
    if (action === "description") draft.description = await longTextInput("Descrição do issue", draft.description);
    if (action === "labels") {
      draft.labels = await checkbox({
        message: "Selecione TODAS as labels do issue",
        choices: labelChoices(inputData.labels, draft.labels.length ? draft.labels : [inputData.doingLabel])
      });
    }
    if (action === "assignee") {
      draft.assigneeId = await select({
        message: "Responsável pelo issue",
        choices: [...memberChoices(membersWithCurrentFirst), { name: "Ninguém", value: 0 }],
        default: draft.assigneeId
      });
    }
    if (action === "milestone") {
      draft.milestoneId = await select({
        message: "Milestone do issue",
        choices: milestoneChoices(inputData.milestones),
        default: draft.milestoneId
      });
    }
    if (action === "reviewer") {
      draft.reviewerId = await select({
        message: "Pessoa que vai revisar o MR",
        choices: memberChoices(inputData.members),
        default: draft.reviewerId
      });
    }
  }
}

async function promptMrDraft(inputData: {
  members: GitLabMember[];
  savedReviewerId?: number;
  savedReviewerName?: string;
  defaultTargetBranch: string;
}) {
  let reviewerId = inputData.savedReviewerId;
  if (reviewerId) {
    const useSavedReviewer = await confirm({
      message: `Usar reviewer salvo: ${inputData.savedReviewerName ?? reviewerId}?`,
      default: true
    });
    if (!useSavedReviewer) reviewerId = undefined;
  }

  const draft: MrDraft = {
    reviewerId: reviewerId ?? await select({
      message: "Reviewer do MR",
      choices: memberChoices(inputData.members)
    }),
    extraDescription: await longTextInput("Descricao adicional do Merge Request"),
    targetBranch: await input({
      message: "Branch alvo do MR",
      default: inputData.defaultTargetBranch,
      validate: (value) => value.trim() ? true : "Informe a branch alvo."
    })
  };

  while (true) {
    printMrDraft(draft, inputData.members);
    const action = await select({
      message: "Está tudo certo?",
      choices: [
        { name: "Criar merge request", value: "confirm" },
        { name: "Corrigir reviewer", value: "reviewer" },
        { name: "Corrigir descrição adicional", value: "description" },
        { name: "Corrigir branch alvo", value: "target" },
        { name: "Cancelar fluxo", value: "cancel" }
      ]
    });

    if (action === "confirm") return draft;
    if (action === "cancel") throw new FlowCancelled();
    if (action === "reviewer") {
      draft.reviewerId = await select({
        message: "Reviewer do MR",
        choices: memberChoices(inputData.members),
        default: draft.reviewerId
      });
    }
    if (action === "description") {
      draft.extraDescription = await longTextInput("Descricao adicional do Merge Request", draft.extraDescription);
    }
    if (action === "target") {
      draft.targetBranch = await input({
        message: "Branch alvo do MR",
        default: draft.targetBranch,
        validate: (value) => value.trim() ? true : "Informe a branch alvo."
      });
    }
  }
}

async function start(config: RuntimeConfig) {
  await ensureGitRepository();
  await ensureOriginRemote();
  await confirmDirtyWorkingTree();

  const api = createGitLabClient(config);
  const [labels, members, milestones, currentUser] = await Promise.all([
    api.getLabels(),
    api.getMembers(),
    api.getMilestones(),
    api.getCurrentUser()
  ]);

  const draft = await promptStartDraft({
    labels,
    members,
    milestones,
    currentUserId: currentUser.id,
    doingLabel: config.doingLabel
  });
  const reviewer = members.find((m) => m.id === draft.reviewerId);
  const finalLabels = Array.from(new Set([...draft.labels, config.doingLabel]));

  let issue;
  let finalBranch = `${draft.type}(#issue)/${slugify(draft.title)}`;
  try {
    issue = await api.createIssue({
      title: draft.title.trim(),
      description: draft.description,
      labels: finalLabels,
      assigneeId: draft.assigneeId || undefined,
      milestoneId: draft.milestoneId || undefined,
      dueDate: todayDate()
    });

    finalBranch = `${draft.type}(#${issue.iid})/${slugify(draft.title)}`;

    await saveState({
      issueIid: issue.iid,
      issueUrl: issue.web_url,
      type: draft.type,
      title: draft.title.trim(),
      branch: finalBranch,
      labels: finalLabels,
      reviewerId: draft.reviewerId,
      reviewerName: reviewer ? `${reviewer.name} (@${reviewer.username})` : undefined
    });

    if (await branchExists(finalBranch)) {
      throw new Error(`A branch "${finalBranch}" já existe localmente ou em origin.`);
    }

    await git(["checkout", "-b", finalBranch]);
  } catch (error) {
    if (issue) {
      console.error("\nO issue foi criado, mas o fluxo não terminou.");
      console.error(`Issue: #${issue.iid}`);
      console.error(issue.web_url);
      console.error(`Branch esperada: ${finalBranch}`);
      console.error("Você pode corrigir o problema e rodar `gl-work status` para retomar o contexto.");
    }
    throw error;
  }

  await saveState({
    issueIid: issue.iid,
    issueUrl: issue.web_url,
    type: draft.type,
    title: draft.title.trim(),
    branch: finalBranch,
    labels: finalLabels,
    reviewerId: draft.reviewerId,
    reviewerName: reviewer ? `${reviewer.name} (@${reviewer.username})` : undefined
  });

  console.log(`\nIssue criado: #${issue.iid}`);
  console.log(issue.web_url);
  console.log(`Branch criada: ${finalBranch}`);
  console.log(`Reviewer escolhido: ${reviewer ? `${reviewer.name} (@${reviewer.username})` : "nenhum"}`);
  console.log(`Commit sugerido: ${draft.type}(#${issue.iid}): ${draft.title.trim()}`);
}

async function mr(config: RuntimeConfig) {
  await ensureGitRepository();
  await ensureOriginRemote();

  const api = createGitLabClient(config);
  const [labels, members, currentUser] = await Promise.all([api.getLabels(), api.getMembers(), api.getCurrentUser()]);
  const saved = await loadState();
  const stateLabels = [config.doingLabel, config.reviewLabel].filter(Boolean);

  const branch = await currentBranch();
  const match = branch.match(/^([a-z]+)\(#(\d+)\)\/(.+)$/);
  if (!match) throw new Error("Branch inválida. Esperado: docs(#5)/adicionar-etc");

  const existingMergeRequest = await api.getOpenMergeRequestForBranch(branch);
  if (existingMergeRequest) {
    console.log(`\nJá existe uma MR aberta para esta branch: !${existingMergeRequest.iid}`);
    console.log(existingMergeRequest.web_url);
    return;
  }

  const [, type, issueIidRaw, slug] = match;
  const issueIid = Number(issueIidRaw);
  const niceTitle = saved?.issueIid === issueIid ? saved.title : slug.replace(/-/g, " ");

  const mrTitle = `${type}(#${issueIid}): ${niceTitle}`;
  const draft = await promptMrDraft({
    members,
    savedReviewerId: saved?.reviewerId,
    savedReviewerName: saved?.reviewerName,
    defaultTargetBranch: config.defaultTargetBranch
  });

  await git(["push", "-u", "origin", branch]);

  const mrDescription = draft.extraDescription.trim()
    ? `Closes #${issueIid}\n\n${draft.extraDescription.trim()}`
    : `Closes #${issueIid}`;

  let mergeRequest;
  try {
    mergeRequest = await api.createMergeRequest({
      sourceBranch: branch,
      targetBranch: draft.targetBranch.trim(),
      title: mrTitle,
      description: mrDescription,
      assigneeId: currentUser.id,
      reviewerId: draft.reviewerId
    });
  } catch (error) {
    console.error("\nO push foi concluído, mas a MR não foi criada.");
    console.error(`Branch enviada: ${branch}`);
    console.error("Você pode corrigir o problema e rodar `gl-work mr` de novo. Se a MR já tiver sido criada no GitLab, a CLI vai detectar.");
    throw error;
  }

  try {
    const issue = await api.getIssue(issueIid);
    const labelsWithoutState = issue.labels.filter((label) => !stateLabels.includes(label));
    const finalLabels = Array.from(new Set([...labelsWithoutState, config.reviewLabel]));

    const reviewLabelExists = labels.some((label) => label.name === config.reviewLabel);
    if (!reviewLabelExists) {
      console.warn(`Aviso: a label "${config.reviewLabel}" não foi encontrada no projeto. O GitLab pode criar/ignorar dependendo da configuração.`);
    }

    await api.updateIssueLabels(issueIid, finalLabels);
  } catch (error) {
    console.error("\nA MR foi criada, mas não consegui mover o issue para review.");
    console.error(`MR: !${mergeRequest.iid}`);
    console.error(mergeRequest.web_url);
    console.error(`Issue: #${issueIid}`);
    throw error;
  }

  console.log(`\nMR criado: !${mergeRequest.iid}`);
  console.log(mergeRequest.web_url);
  console.log(`Target branch: ${draft.targetBranch.trim()}`);
  console.log(`Issue #${issueIid} movido para ${config.reviewLabel}`);
}

async function status(config: RuntimeConfig) {
  await ensureGitRepository();

  const saved = await loadState();
  const branch = await currentBranch();
  const statusOutput = await workingTreeStatus();
  const originExists = await hasOriginRemote();

  console.log("\nStatus do gl-work");
  console.log(`Branch atual: ${branch || "nenhuma"}`);
  console.log(`Remote origin: ${originExists ? "configurado" : "não encontrado"}`);
  console.log(`Mudanças locais: ${statusOutput ? "sim" : "não"}`);

  if (saved) {
    console.log("\nEstado salvo:");
    console.log(`Issue: #${saved.issueIid}`);
    console.log(saved.issueUrl);
    console.log(`Título: ${saved.title}`);
    console.log(`Branch esperada: ${saved.branch}`);
    console.log(`Labels: ${saved.labels.join(", ") || "nenhuma"}`);
    console.log(`Reviewer: ${saved.reviewerName ?? saved.reviewerId ?? "não salvo"}`);
    console.log(`Branch atual confere: ${branch === saved.branch ? "sim" : "não"}`);
  } else {
    console.log("\nNenhum estado salvo para este diretório.");
  }

  if (!branch) return;

  try {
    const api = createGitLabClient(config);
    const mergeRequest = await api.getOpenMergeRequestForBranch(branch);
    if (mergeRequest) {
      console.log("\nMR aberta:");
      console.log(`!${mergeRequest.iid} ${mergeRequest.title}`);
      console.log(mergeRequest.web_url);
    } else {
      console.log("\nMR aberta: nenhuma encontrada para a branch atual");
    }
  } catch (error) {
    console.warn("\nNão consegui consultar MRs abertas no GitLab.");
    console.warn(error instanceof Error ? error.message : error);
  }
}

async function main() {
  const command = process.argv[2];

  if (command === "config") {
    await configureCli();
    return;
  }

  const config = await ensureRuntimeConfig();

  if (command === "start") await start(config);
  else if (command === "mr") await mr(config);
  else if (command === "status") await status(config);
  else {
    console.log("Uso:");
    console.log("  gl-work start");
    console.log("  gl-work mr");
    console.log("  gl-work status");
    console.log("  gl-work config");
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof FlowCancelled) {
    console.log("\nFluxo cancelado. Nada foi criado ou alterado nesta etapa.");
    process.exit(0);
  }
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
