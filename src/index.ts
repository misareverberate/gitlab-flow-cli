#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { checkbox, input, select, confirm, editor } from "@inquirer/prompts";
import { execa } from "execa";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  GitLabClient,
  GitLabDiscussion,
  GitLabIssue,
  GitLabLabel,
  GitLabMember,
  GitLabMilestone,
  GitLabMR,
  GitLabMRApprovals,
  GitLabPipeline
} from "./gitlab.js";
import {
  clearProjectStateFile,
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

type ReviewAnalysis = {
  fetched: boolean;
  mergeCheck: "clean" | "conflict" | "unknown";
  mrFiles: string[];
  targetFiles: string[];
  overlapFiles: string[];
  warnings: string[];
};

type ReviewContext = {
  mr: GitLabMR;
  approvals: GitLabMRApprovals | null;
  latestPipeline: GitLabPipeline | null;
  unresolvedDiscussions: GitLabDiscussion[];
  closingIssues: GitLabIssue[];
  relatedIssues: GitLabIssue[];
  analysis?: ReviewAnalysis;
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

async function gitResult(args: string[]) {
  return execa("git", args, { reject: false });
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

async function localBranchExists(branch: string) {
  return gitOk(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
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

function parseIssueIidFromText(value?: string) {
  if (!value) return null;
  const closingMatch = value.match(/(?:Closes|Close|Fixes|Fix|Resolves|Resolve)\s+(?:[\w./-]+)?#(\d+)/i);
  const genericMatch = value.match(/(?:^|\s)(?:[\w./-]+)?#(\d+)/);
  const raw = closingMatch?.[1] ?? genericMatch?.[1];
  return raw ? Number(raw) : null;
}

function compactList(values: string[], limit = 8) {
  if (values.length <= limit) return values;
  return [...values.slice(0, limit), `... +${values.length - limit}`];
}

function unique(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function unresolvedDiscussions(discussions: GitLabDiscussion[]) {
  return discussions.filter((discussion) =>
    discussion.notes.some((note) => note.resolvable && !note.resolved)
  );
}

function discussionSummary(mr: GitLabMR, discussions: GitLabDiscussion[]) {
  return discussions.flatMap((discussion) =>
    discussion.notes
      .filter((note) => note.resolvable && !note.resolved)
      .map((note) => {
        const author = note.author ? `${note.author.name} (@${note.author.username})` : "autor desconhecido";
        const firstLine = note.body.split("\n")[0]?.trim() || "Discussão sem texto";
        return `${author}: ${firstLine} (${mr.web_url}#note_${note.id})`;
      })
  );
}

function latestPipeline(pipelines: GitLabPipeline[]) {
  return pipelines[0] ?? null;
}

function pipelineAllowsMerge(pipeline: GitLabPipeline | null) {
  return !pipeline || ["success", "skipped"].includes(pipeline.status);
}

function blockingMergeStatus(mr: GitLabMR) {
  const status = mr.detailed_merge_status ?? mr.merge_status;
  if (!status) return null;
  const blockingStatuses = new Set([
    "approvals_syncing",
    "checking",
    "ci_must_pass",
    "ci_still_running",
    "commits_status",
    "conflict",
    "discussions_not_resolved",
    "draft_status",
    "jira_association_missing",
    "merge_request_blocked",
    "merge_time",
    "need_rebase",
    "not_approved",
    "not_open",
    "preparing",
    "requested_changes",
    "security_policy_violations",
    "unchecked"
  ]);
  return blockingStatuses.has(status) ? status : null;
}

function reportLines(context: ReviewContext) {
  const { mr, approvals, latestPipeline: pipeline, unresolvedDiscussions: discussions, closingIssues, relatedIssues, analysis } = context;
  const issueList = closingIssues.length ? closingIssues : relatedIssues;
  return [
    `# Revisão da MR !${mr.iid}`,
    "",
    `**Título:** ${mr.title}`,
    `**URL:** ${mr.web_url}`,
    `**Estado:** ${mr.state ?? "desconhecido"}`,
    `**Branch:** ${mr.source_branch} -> ${mr.target_branch}`,
    `**Autor:** ${mr.author ? `${mr.author.name} (@${mr.author.username})` : "desconhecido"}`,
    `**Pipeline:** ${pipeline ? `${pipeline.status} (#${pipeline.id})` : "nenhum encontrado"}`,
    `**Aprovações restantes:** ${approvals?.approvals_left ?? "desconhecido"}`,
    `**Discussões pendentes:** ${discussions.length}`,
    `**Issues relacionadas:** ${issueList.length ? issueList.map((issue) => `#${issue.iid}`).join(", ") : "nenhuma"}`,
    "",
    "## Análise local",
    analysis
      ? `Merge simulado: ${analysis.mergeCheck === "clean" ? "sem conflito Git" : analysis.mergeCheck === "conflict" ? "conflito detectado" : "inconclusivo"}`
      : "Análise local ainda não executada.",
    analysis ? `Arquivos da MR: ${analysis.mrFiles.length}` : "",
    analysis ? `Arquivos sobrepostos com a branch alvo: ${analysis.overlapFiles.length}` : "",
    ...(analysis?.overlapFiles.length ? ["", "Arquivos sobrepostos:", ...compactList(analysis.overlapFiles, 20).map((file) => `- ${file}`)] : []),
    ...(analysis?.warnings.length ? ["", "Avisos:", ...compactList(analysis.warnings, 20).map((warning) => `- ${warning}`)] : []),
    ...(discussions.length ? ["", "Discussões pendentes:", ...compactList(discussionSummary(mr, discussions), 20).map((item) => `- ${item}`)] : [])
  ].filter((line) => line !== "");
}

function formatReviewReport(context: ReviewContext) {
  return reportLines(context).join("\n");
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

async function resolveReviewMergeRequest(api: GitLabClient, mergeRequestArg?: string) {
  if (mergeRequestArg) {
    const normalized = mergeRequestArg.replace(/^!/, "");
    const iid = Number(normalized);
    if (!Number.isInteger(iid) || iid <= 0) throw new Error("Informe a MR como número ou !número. Exemplo: gl-work review !123");
    return api.getMergeRequest(iid);
  }

  const branch = await currentBranch();
  const mergeRequest = await api.getOpenMergeRequestForBranch(branch);
  if (!mergeRequest) {
    throw new Error("Não encontrei MR aberta para a branch atual. Use `gl-work review !123` para informar uma MR específica.");
  }
  return mergeRequest;
}

function parseReviewArgs() {
  const args = process.argv.slice(3);
  return {
    mergeRequestArg: args.find((arg) => !arg.startsWith("--")),
    report: args.includes("--report"),
    commentReport: args.includes("--comment-report")
  };
}

async function refExists(ref: string) {
  return gitOk(["rev-parse", "--verify", ref]);
}

async function changedFiles(from: string, to: string) {
  const result = await gitResult(["diff", "--name-only", `${from}..${to}`]);
  if (result.exitCode !== 0) return [];
  return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

function reviewWarnings(overlapFiles: string[], mrFiles: string[]) {
  const centralFiles = mrFiles.filter((file) =>
    /(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|README\.md|CHANGELOG\.md)$/i.test(file) ||
    /(routes?|roles?|permissions?|config|enum|migration|translations?|locales?)/i.test(file)
  );
  return [
    ...overlapFiles.map((file) => `Arquivo também mudou na branch alvo: ${file}`),
    ...centralFiles.map((file) => `Arquivo central exige revisão cuidadosa: ${file}`)
  ];
}

async function analyzeMergeRequest(mr: GitLabMR): Promise<ReviewAnalysis> {
  const sourceRef = `origin/${mr.source_branch}`;
  const targetRef = `origin/${mr.target_branch}`;
  const fetchResult = await gitResult(["fetch", "origin"]);
  const fetched = fetchResult.exitCode === 0;

  if (!fetched || !(await refExists(sourceRef)) || !(await refExists(targetRef))) {
    return {
      fetched,
      mergeCheck: "unknown",
      mrFiles: [],
      targetFiles: [],
      overlapFiles: [],
      warnings: ["Não consegui atualizar as branches remotas para análise local."]
    };
  }

  const base = await gitOutput(["merge-base", sourceRef, targetRef]);
  const [mrFiles, targetFiles] = await Promise.all([
    changedFiles(base, sourceRef),
    changedFiles(base, targetRef)
  ]);
  const overlapFiles = mrFiles.filter((file) => targetFiles.includes(file));
  const mergeTree = await gitResult(["merge-tree", "--write-tree", targetRef, sourceRef]);
  const mergeCheck = mergeTree.exitCode === 0
    ? "clean"
    : /unknown option|usage:/i.test(mergeTree.stderr)
      ? "unknown"
      : "conflict";

  return {
    fetched,
    mergeCheck,
    mrFiles,
    targetFiles,
    overlapFiles,
    warnings: unique(reviewWarnings(overlapFiles, mrFiles))
  };
}

function printReviewSummary(context: ReviewContext) {
  const { mr, approvals, latestPipeline: pipeline, unresolvedDiscussions: discussions, closingIssues, relatedIssues, analysis } = context;
  console.log("\nResumo da revisão");
  console.log(`MR: !${mr.iid} ${mr.title}`);
  console.log(mr.web_url);
  console.log(`Estado: ${mr.state ?? "desconhecido"}`);
  console.log(`Branch: ${mr.source_branch} -> ${mr.target_branch}`);
  console.log(`Autor: ${mr.author ? `${mr.author.name} (@${mr.author.username})` : "desconhecido"}`);
  console.log(`Reviewers: ${mr.reviewers?.length ? mr.reviewers.map((r) => `${r.name} (@${r.username})`).join(", ") : "nenhum"}`);
  console.log(`Discussões resolvidas: ${mr.blocking_discussions_resolved === false ? "não" : "sim/desconhecido"}`);
  console.log(`Status de merge GitLab: ${mr.detailed_merge_status ?? mr.merge_status ?? "desconhecido"}`);
  if (approvals) {
    console.log(`Aprovações restantes: ${approvals.approvals_left ?? "desconhecido"}`);
    console.log(`Aprovado por: ${approvals.approved_by?.map((item) => item.user.name).join(", ") || "ninguém"}`);
  }
  console.log(`Pipeline: ${pipeline ? `${pipeline.status} (#${pipeline.id})` : "nenhum encontrado"}`);
  console.log(`Discussões pendentes: ${discussions.length}`);
  console.log(`Issues que fecham no merge: ${closingIssues.length ? closingIssues.map((issue) => `#${issue.iid}`).join(", ") : "nenhuma"}`);
  console.log(`Issues relacionadas: ${relatedIssues.length ? relatedIssues.map((issue) => `#${issue.iid}`).join(", ") : "nenhuma"}`);

  if (!analysis) return;

  console.log("\nAnálise local");
  console.log(`Merge simulado: ${analysis.mergeCheck === "clean" ? "sem conflito Git" : analysis.mergeCheck === "conflict" ? "conflito detectado" : "inconclusivo"}`);
  console.log(`Arquivos da MR: ${analysis.mrFiles.length}`);
  console.log(`Arquivos também alterados na branch alvo: ${analysis.overlapFiles.length}`);
  for (const file of compactList(analysis.overlapFiles)) console.log(`- ${file}`);
  if (analysis.warnings.length) {
    console.log("\nAtenção:");
    for (const warning of compactList(analysis.warnings, 10)) console.log(`- ${warning}`);
  }
}

async function commentOnMergeRequest(api: GitLabClient, mr: GitLabMR, title = "Comentário de revisão") {
  const body = await longTextInput(title);
  if (!body.trim()) {
    console.log("\nComentário vazio. Nada foi enviado.");
    return;
  }
  const shouldSend = await confirm({ message: "Enviar comentário na MR?", default: true });
  if (!shouldSend) throw new FlowCancelled();
  await api.createMergeRequestNote(mr.iid, body.trim());
  console.log("\nComentário enviado.");
}

async function requestChanges(api: GitLabClient, mr: GitLabMR, analysis?: ReviewAnalysis) {
  const defaultBody = [
    "## Ajustes solicitados",
    "",
    analysis?.warnings.length ? "Pontos de atenção encontrados:" : "",
    ...compactList(analysis?.warnings ?? [], 8).map((warning) => `- ${warning}`),
    "",
    "Descreva aqui os ajustes necessários."
  ].filter(Boolean).join("\n");
  const body = await longTextInput("Mensagem de ajustes", defaultBody);
  if (!body.trim()) {
    console.log("\nMensagem vazia. Nada foi enviado.");
    return;
  }
  const shouldSend = await confirm({ message: "Postar pedido de ajustes na MR?", default: true });
  if (!shouldSend) throw new FlowCancelled();
  await api.createMergeRequestNote(mr.iid, body.trim());
  console.log("\nPedido de ajustes enviado.");
}

async function postReviewReport(api: GitLabClient, context: ReviewContext) {
  const body = formatReviewReport(context);
  console.log(`\n${body}`);
  const shouldPost = await confirm({ message: "Postar este relatório na MR?", default: true });
  if (!shouldPost) throw new FlowCancelled();
  await api.createMergeRequestNote(context.mr.iid, body);
  console.log("\nRelatório postado na MR.");
}

async function approveMergeRequest(api: GitLabClient, context: ReviewContext) {
  printReviewSummary(context);
  if (context.analysis?.mergeCheck === "conflict") {
    const proceed = await confirm({ message: "Há conflito Git detectado. Aprovar mesmo assim?", default: false });
    if (!proceed) throw new FlowCancelled();
  }
  if (context.analysis?.warnings.length) {
    const proceed = await confirm({ message: "Há avisos de risco. Aprovar mesmo assim?", default: false });
    if (!proceed) throw new FlowCancelled();
  }
  if (!pipelineAllowsMerge(context.latestPipeline)) {
    const proceed = await confirm({ message: `O pipeline está "${context.latestPipeline?.status}". Aprovar mesmo assim?`, default: false });
    if (!proceed) throw new FlowCancelled();
  }
  if (context.unresolvedDiscussions.length) {
    const proceed = await confirm({ message: `Há ${context.unresolvedDiscussions.length} discussão(ões) pendente(s). Aprovar mesmo assim?`, default: false });
    if (!proceed) throw new FlowCancelled();
  }
  const shouldApprove = await confirm({ message: `Aprovar MR !${context.mr.iid}?`, default: true });
  if (!shouldApprove) throw new FlowCancelled();
  await api.approveMergeRequest(context.mr.iid, context.mr.sha);
  console.log("\nMR aprovada.");
}

async function loadReviewContext(api: GitLabClient, mr: GitLabMR, analysis?: ReviewAnalysis): Promise<ReviewContext> {
  const [approvals, pipelines, discussions, closingIssues, relatedIssues] = await Promise.all([
    api.getMergeRequestApprovals(mr.iid).catch(() => null),
    api.getMergeRequestPipelines(mr.iid).catch(() => []),
    api.getMergeRequestDiscussions(mr.iid).catch(() => []),
    api.getIssuesClosingOnMerge(mr.iid).catch(() => []),
    api.getRelatedIssues(mr.iid).catch(() => [])
  ]);

  return {
    mr,
    approvals,
    latestPipeline: latestPipeline(pipelines),
    unresolvedDiscussions: unresolvedDiscussions(discussions),
    closingIssues,
    relatedIssues,
    analysis
  };
}

async function resolveIssueForMerge(mr: GitLabMR, closingIssues: GitLabIssue[], relatedIssues: GitLabIssue[]) {
  const issue = closingIssues[0] ?? relatedIssues[0];
  if (issue) return issue.iid;

  const parsedIssueIid = parseIssueIidFromText(`${mr.title}\n${mr.description ?? ""}`);
  return parsedIssueIid;
}

async function checkoutMergeRequestWorktree(mr: GitLabMR) {
  await git(["fetch", "origin"]);
  const worktreePath = path.join(tmpdir(), `gl-work-mr-${mr.iid}-${Date.now()}`);
  await git(["worktree", "add", worktreePath, `origin/${mr.source_branch}`]);
  console.log("\nWorktree criada para revisão local:");
  console.log(worktreePath);
  console.log("Você pode abrir esse diretório para revisar a MR sem mexer na branch atual.");
}

async function cleanupAfterMerge(targetBranch: string, sourceBranch: string) {
  const shouldCleanup = await confirm({ message: "Fazer limpeza local pós-merge?", default: true });
  if (!shouldCleanup) return;

  const current = await currentBranch();
  if (current !== targetBranch) {
    if (await localBranchExists(targetBranch)) {
      await git(["checkout", targetBranch]);
    } else if (await refExists(`origin/${targetBranch}`)) {
      await git(["checkout", "-B", targetBranch, `origin/${targetBranch}`]);
    } else {
      console.warn(`Branch alvo origin/${targetBranch} não encontrada localmente. Pulando checkout/pull.`);
      return;
    }
  }
  await git(["pull", "--ff-only", "origin", targetBranch]);

  if (await localBranchExists(sourceBranch)) {
    const shouldDeleteBranch = await confirm({ message: `Remover branch local ${sourceBranch}?`, default: true });
    if (shouldDeleteBranch) await git(["branch", "-d", sourceBranch]);
  }

  const shouldClearState = await confirm({ message: "Limpar estado salvo do gl-work para este diretório?", default: true });
  if (shouldClearState) await clearProjectStateFile();
}

async function mergeReviewedMergeRequest(api: GitLabClient, config: RuntimeConfig, context: ReviewContext) {
  const freshMr = await api.getMergeRequest(context.mr.iid);
  const freshContext = await loadReviewContext(api, freshMr, context.analysis);
  const issueIid = await resolveIssueForMerge(freshMr, freshContext.closingIssues, freshContext.relatedIssues);

  printReviewSummary(freshContext);

  if (freshMr.state !== "opened") throw new Error(`A MR !${freshMr.iid} não está aberta.`);
  const blockedByMergeStatus = blockingMergeStatus(freshMr);
  if (blockedByMergeStatus) throw new Error(`GitLab indica que a MR não está pronta para merge: ${blockedByMergeStatus}.`);
  if (freshMr.has_conflicts || freshContext.analysis?.mergeCheck === "conflict") throw new Error("A MR tem conflito Git. Atualize a branch antes de mergear.");
  if (freshMr.blocking_discussions_resolved === false || freshContext.unresolvedDiscussions.length) throw new Error("A MR tem discussões pendentes.");
  if (!pipelineAllowsMerge(freshContext.latestPipeline)) throw new Error(`Pipeline não está pronto para merge: ${freshContext.latestPipeline?.status}.`);
  if ((freshContext.approvals?.approvals_left ?? 0) > 0) {
    const proceed = await confirm({ message: `Ainda faltam ${freshContext.approvals?.approvals_left} aprovação(ões). Mergear mesmo assim?`, default: false });
    if (!proceed) throw new FlowCancelled();
  }
  if (!issueIid) {
    const proceed = await confirm({ message: "Não encontrei issue vinculada no título/descrição. Mergear mesmo assim?", default: false });
    if (!proceed) throw new FlowCancelled();
  }

  const shouldMerge = await confirm({
    message: `Mergear !${freshMr.iid} em ${freshMr.target_branch}?`,
    default: false
  });
  if (!shouldMerge) throw new FlowCancelled();

  const merged = await api.mergeMergeRequest({
    mergeRequestIid: freshMr.iid,
    sha: freshMr.sha,
    shouldRemoveSourceBranch: true
  });

  console.log("\nMR mergeada.");
  console.log(merged.web_url);

  if (issueIid) {
    try {
      const issue = await api.getIssue(issueIid);
      const labelsWithoutState = issue.labels.filter((label) => ![config.reviewLabel, config.doingLabel].includes(label));
      const finalLabels = Array.from(new Set([...labelsWithoutState, config.doneLabel]));
      await api.updateIssueLabels(issueIid, finalLabels);
      await api.closeIssue(issueIid);
      console.log(`Issue #${issueIid} fechado no GitLab e movido para ${config.doneLabel}.`);
    } catch (error) {
      console.error(`\nA MR foi mergeada, mas não consegui fechar o issue #${issueIid}.`);
      console.error(error instanceof Error ? error.message : error);
    }
  }

  await cleanupAfterMerge(freshMr.target_branch, freshMr.source_branch);
}

async function review(config: RuntimeConfig) {
  await ensureGitRepository();
  await ensureOriginRemote();

  const api = createGitLabClient(config);
  const { mergeRequestArg, report, commentReport } = parseReviewArgs();
  let mr = await resolveReviewMergeRequest(api, mergeRequestArg);
  let analysis: ReviewAnalysis | undefined;

  if (report || commentReport) {
    analysis = await analyzeMergeRequest(mr);
    const context = await loadReviewContext(api, mr, analysis);
    const body = formatReviewReport(context);
    console.log(`\n${body}`);
    if (commentReport) {
      await api.createMergeRequestNote(mr.iid, body);
      console.log("\nRelatório postado na MR.");
    }
    return;
  }

  while (true) {
    const context = await loadReviewContext(api, mr, analysis);
    printReviewSummary(context);

    const action = await select({
      message: "O que você quer fazer?",
      choices: [
        { name: "Atualizar resumo da MR", value: "refresh" },
        { name: "Checar riscos e conflitos", value: "analyze" },
        { name: "Postar relatório da análise na MR", value: "post-report" },
        { name: "Criar checkout seguro da MR", value: "checkout" },
        { name: "Comentar na MR", value: "comment" },
        { name: "Pedir ajustes", value: "changes" },
        { name: "Aprovar MR", value: "approve" },
        { name: "Mergear e fechar issue", value: "merge" },
        { name: "Sair", value: "exit" }
      ]
    });

    if (action === "exit") return;
    if (action === "refresh") mr = await api.getMergeRequest(mr.iid);
    if (action === "analyze") {
      analysis = await analyzeMergeRequest(mr);
      const analyzedContext = await loadReviewContext(api, mr, analysis);
      printReviewSummary(analyzedContext);
      const shouldPost = await confirm({ message: "Postar este relatório de análise na MR?", default: false });
      if (shouldPost) await postReviewReport(api, analyzedContext);
    }
    if (action === "post-report") await postReviewReport(api, context);
    if (action === "checkout") await checkoutMergeRequestWorktree(mr);
    if (action === "comment") await commentOnMergeRequest(api, mr);
    if (action === "changes") await requestChanges(api, mr, analysis);
    if (action === "approve") await approveMergeRequest(api, context);
    if (action === "merge") await mergeReviewedMergeRequest(api, config, context);

    mr = await api.getMergeRequest(mr.iid).catch(() => mr);
  }
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
  else if (command === "review") await review(config);
  else if (command === "status") await status(config);
  else {
    console.log("Uso:");
    console.log("  gl-work start");
    console.log("  gl-work mr");
    console.log("  gl-work review [!iid] [--report|--comment-report]");
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
