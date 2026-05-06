#!/usr/bin/env node
import { checkbox, input, select, confirm } from "@inquirer/prompts";
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

async function start(config: RuntimeConfig) {
  const api = createGitLabClient(config);
  const [labels, members, milestones, currentUser] = await Promise.all([
    api.getLabels(),
    api.getMembers(),
    api.getMilestones(),
    api.getCurrentUser()
  ]);
  const membersWithCurrentFirst = preferredMemberOrder(members, currentUser.id);

  const type = await select({ message: "Tipo do commit/MR", choices: TYPES.map((v) => ({ name: v, value: v })) });
  const title = await input({ message: "Título do issue" });
  const description = await input({ message: "Descrição do issue" });

  const selectedLabels = await checkbox({
    message: "Selecione TODAS as labels do issue",
    choices: labelChoices(labels, [config.doingLabel])
  });

  const assignee = await select({
    message: "Responsável pelo issue",
    choices: [...memberChoices(membersWithCurrentFirst), { name: "Ninguém", value: 0 }]
  });

  const milestoneId = await select({
    message: "Milestone do issue",
    choices: milestoneChoices(milestones)
  });

  const reviewerId = await select({
    message: "Pessoa que vai revisar o MR",
    choices: memberChoices(members)
  });
  const reviewer = members.find((m) => m.id === reviewerId);

  const finalLabels = Array.from(new Set([...selectedLabels, config.doingLabel]));

  const issue = await api.createIssue({
    title,
    description,
    labels: finalLabels,
    assigneeId: assignee || undefined,
    milestoneId: milestoneId || undefined,
    dueDate: todayDate()
  });

  const branch = `${type}(#${issue.iid})/${slugify(title)}`;
  await git(["checkout", "-b", branch]);

  await saveState({
    issueIid: issue.iid,
    issueUrl: issue.web_url,
    type,
    title,
    branch,
    labels: finalLabels,
    reviewerId,
    reviewerName: reviewer ? `${reviewer.name} (@${reviewer.username})` : undefined
  });

  console.log(`\nIssue criado: #${issue.iid}`);
  console.log(issue.web_url);
  console.log(`Branch criada: ${branch}`);
  console.log(`Reviewer escolhido: ${reviewer ? `${reviewer.name} (@${reviewer.username})` : "nenhum"}`);
  console.log(`Commit sugerido: ${type}(#${issue.iid}): ${title}`);
}

async function mr(config: RuntimeConfig) {
  const api = createGitLabClient(config);
  const [labels, members, currentUser] = await Promise.all([api.getLabels(), api.getMembers(), api.getCurrentUser()]);
  const saved = await loadState();
  const stateLabels = [config.doingLabel, config.reviewLabel].filter(Boolean);
  const membersWithCurrentFirst = preferredMemberOrder(members, currentUser.id);

  const branch = (await execa("git", ["branch", "--show-current"])).stdout.trim();
  const match = branch.match(/^([a-z]+)\(#(\d+)\)\/(.+)$/);
  if (!match) throw new Error("Branch inválida. Esperado: docs(#5)/adicionar-etc");

  const [, type, issueIidRaw, slug] = match;
  const issueIid = Number(issueIidRaw);
  const niceTitle = saved?.issueIid === issueIid ? saved.title : slug.replace(/-/g, " ");

  let reviewerId = saved?.reviewerId;
  if (reviewerId) {
    const useSavedReviewer = await confirm({
      message: `Usar reviewer salvo: ${saved?.reviewerName ?? reviewerId}?`,
      default: true
    });
    if (!useSavedReviewer) reviewerId = undefined;
  }

  if (!reviewerId) {
    reviewerId = await select({
      message: "Reviewer do MR",
      choices: memberChoices(members)
    });
  }

  await git(["push", "-u", "origin", branch]);

  const mrTitle = `${type}(#${issueIid}): ${niceTitle}`;
  const mrExtraDescription = await input({
    message: "Descricao adicional do Merge Request",
    default: ""
  });
  const mrDescription = mrExtraDescription.trim()
    ? `Closes #${issueIid}\n\n${mrExtraDescription.trim()}`
    : `Closes #${issueIid}`;

  const mergeRequest = await api.createMergeRequest({
    sourceBranch: branch,
    targetBranch: config.defaultTargetBranch,
    title: mrTitle,
    description: mrDescription,
    assigneeId: currentUser.id,
    reviewerId
  });

  const issue = await api.getIssue(issueIid);
  const labelsWithoutState = issue.labels.filter((label) => !stateLabels.includes(label));
  const finalLabels = Array.from(new Set([...labelsWithoutState, config.reviewLabel]));

  const reviewLabelExists = labels.some((label) => label.name === config.reviewLabel);
  if (!reviewLabelExists) {
    console.warn(`Aviso: a label "${config.reviewLabel}" não foi encontrada no projeto. O GitLab pode criar/ignorar dependendo da configuração.`);
  }

  await api.updateIssueLabels(issueIid, finalLabels);

  console.log(`\nMR criado: !${mergeRequest.iid}`);
  console.log(mergeRequest.web_url);
  console.log(`Issue #${issueIid} movido para ${config.reviewLabel}`);
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
  else {
    console.log("Uso:");
    console.log("  gl-work start");
    console.log("  gl-work mr");
    console.log("  gl-work config");
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
