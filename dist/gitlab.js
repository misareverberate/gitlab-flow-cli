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
    async closeIssue(issueIid) {
        return this.request(`/projects/${this.project}/issues/${issueIid}`, {
            method: "PUT",
            body: JSON.stringify({ state_event: "close" })
        });
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
    async getMergeRequest(mergeRequestIid) {
        return this.request(`/projects/${this.project}/merge_requests/${mergeRequestIid}?with_merge_status_recheck=true`);
    }
    async getMergeRequestApprovals(mergeRequestIid) {
        return this.request(`/projects/${this.project}/merge_requests/${mergeRequestIid}/approvals`);
    }
    async getMergeRequestPipelines(mergeRequestIid) {
        return this.request(`/projects/${this.project}/merge_requests/${mergeRequestIid}/pipelines?per_page=20`);
    }
    async getMergeRequestDiscussions(mergeRequestIid) {
        return this.request(`/projects/${this.project}/merge_requests/${mergeRequestIid}/discussions?per_page=100`);
    }
    async getIssuesClosingOnMerge(mergeRequestIid) {
        return this.request(`/projects/${this.project}/merge_requests/${mergeRequestIid}/closes_issues`);
    }
    async getRelatedIssues(mergeRequestIid) {
        return this.request(`/projects/${this.project}/merge_requests/${mergeRequestIid}/related_issues`);
    }
    async approveMergeRequest(mergeRequestIid, sha) {
        return this.request(`/projects/${this.project}/merge_requests/${mergeRequestIid}/approve`, {
            method: "POST",
            body: JSON.stringify(sha ? { sha } : {})
        });
    }
    async createMergeRequestNote(mergeRequestIid, body) {
        return this.request(`/projects/${this.project}/merge_requests/${mergeRequestIid}/notes`, {
            method: "POST",
            body: JSON.stringify({ body })
        });
    }
    async mergeMergeRequest(input) {
        return this.request(`/projects/${this.project}/merge_requests/${input.mergeRequestIid}/merge`, {
            method: "PUT",
            body: JSON.stringify({
                ...(input.sha ? { sha: input.sha } : {}),
                squash: input.squash ?? false,
                should_remove_source_branch: input.shouldRemoveSourceBranch ?? true
            })
        });
    }
}
