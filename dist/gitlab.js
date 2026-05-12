export class GitLabClient {
    baseUrl;
    token;
    project;
    constructor(config) {
        this.baseUrl = config.baseUrl.replace(/\/$/, "");
        this.token = config.token;
        this.project = encodeURIComponent(config.projectPath);
    }
    async request(path, init = {}) {
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
        return res.json();
    }
    async getLabels() {
        return this.request(`/projects/${this.project}/labels?per_page=100`);
    }
    async getMembers() {
        return this.request(`/projects/${this.project}/members/all?per_page=100`);
    }
    async getCurrentUser() {
        return this.request("/user");
    }
    async getMilestones() {
        return this.request(`/projects/${this.project}/milestones?state=active&per_page=100`);
    }
    async getIssue(issueIid) {
        return this.request(`/projects/${this.project}/issues/${issueIid}`);
    }
    async createIssue(input) {
        return this.request(`/projects/${this.project}/issues`, {
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
    async updateIssueLabels(issueIid, labels) {
        return this.request(`/projects/${this.project}/issues/${issueIid}`, {
            method: "PUT",
            body: JSON.stringify({ labels: labels.join(",") })
        });
    }
    async createMergeRequest(input) {
        return this.request(`/projects/${this.project}/merge_requests`, {
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
    async getOpenMergeRequestForBranch(sourceBranch) {
        const params = new URLSearchParams({
            state: "opened",
            source_branch: sourceBranch,
            per_page: "1"
        });
        const mergeRequests = await this.request(`/projects/${this.project}/merge_requests?${params.toString()}`);
        return mergeRequests[0] ?? null;
    }
}
