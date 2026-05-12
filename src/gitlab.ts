export type GitLabLabel = { name: string; color?: string; description?: string };
export type GitLabMember = { id: number; username: string; name: string };
export type GitLabMilestone = { id: number; title: string; state: string; due_date?: string | null };
export type GitLabIssue = { iid: number; web_url: string; title: string; labels: string[] };
export type GitLabMR = {
  iid: number;
  web_url: string;
  title: string;
  source_branch?: string;
  target_branch?: string;
  state?: string;
};
export type GitLabUser = { id: number; username: string; name: string };
export type GitLabConfig = {
  baseUrl: string;
  token: string;
  projectPath: string;
};

export class GitLabClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly project: string;

  constructor(config: GitLabConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.token = config.token;
    this.project = encodeURIComponent(config.projectPath);
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.baseUrl}/api/v4${path}`, {
      ...init,
      headers: {
        "PRIVATE-TOKEN": this.token,
        "Content-Type": "application/json",
        ...(init.headers ?? {})
      }
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GitLab API ${res.status}: ${body}`);
    }

    return res.json() as Promise<T>;
  }

  async getLabels(): Promise<GitLabLabel[]> {
    return this.request<GitLabLabel[]>(`/projects/${this.project}/labels?per_page=100`);
  }

  async getMembers(): Promise<GitLabMember[]> {
    return this.request<GitLabMember[]>(`/projects/${this.project}/members/all?per_page=100`);
  }

  async getCurrentUser(): Promise<GitLabUser> {
    return this.request<GitLabUser>("/user");
  }

  async getMilestones(): Promise<GitLabMilestone[]> {
    return this.request<GitLabMilestone[]>(`/projects/${this.project}/milestones?state=active&per_page=100`);
  }

  async getIssue(issueIid: number): Promise<GitLabIssue> {
    return this.request<GitLabIssue>(`/projects/${this.project}/issues/${issueIid}`);
  }

  async createIssue(input: {
    title: string;
    description: string;
    labels: string[];
    assigneeId?: number;
    milestoneId?: number;
    dueDate?: string;
  }): Promise<GitLabIssue> {
    return this.request<GitLabIssue>(`/projects/${this.project}/issues`, {
      method: "POST",
      body: JSON.stringify({
        title: input.title,
        description: input.description,
        labels: input.labels.join(","),
        ...(input.assigneeId ? { assignee_ids: [input.assigneeId] } : {}),
        ...(input.milestoneId ? { milestone_id: input.milestoneId } : {}),
        ...(input.dueDate ? { due_date: input.dueDate } : {})
      })
    });
  }

  async updateIssueLabels(issueIid: number, labels: string[]): Promise<GitLabIssue> {
    return this.request<GitLabIssue>(`/projects/${this.project}/issues/${issueIid}`, {
      method: "PUT",
      body: JSON.stringify({ labels: labels.join(",") })
    });
  }

  async createMergeRequest(input: {
    sourceBranch: string;
    targetBranch: string;
    title: string;
    description: string;
    reviewerId?: number;
    assigneeId?: number;
  }): Promise<GitLabMR> {
    return this.request<GitLabMR>(`/projects/${this.project}/merge_requests`, {
      method: "POST",
      body: JSON.stringify({
        source_branch: input.sourceBranch,
        target_branch: input.targetBranch,
        title: input.title,
        description: input.description,
        remove_source_branch: true,
        squash: false,
        ...(input.assigneeId ? { assignee_ids: [input.assigneeId] } : {}),
        ...(input.reviewerId ? { reviewer_ids: [input.reviewerId] } : {})
      })
    });
  }

  async getOpenMergeRequestForBranch(sourceBranch: string): Promise<GitLabMR | null> {
    const params = new URLSearchParams({
      state: "opened",
      source_branch: sourceBranch,
      per_page: "1"
    });
    const mergeRequests = await this.request<GitLabMR[]>(`/projects/${this.project}/merge_requests?${params.toString()}`);
    return mergeRequests[0] ?? null;
  }
}
