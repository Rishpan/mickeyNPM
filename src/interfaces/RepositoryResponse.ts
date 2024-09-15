interface PullRequestNode {
  createdAt: string;
  closedAt?: string;
  mergedAt?: string;
  state: string;
}

interface IssueNode {
  createdAt: string;
  closedAt?: string;
  state: string;
}

export interface RepositoryResponse {
  repository: {
    pullRequests: {
      edges: { node: PullRequestNode }[];
    };
    issues: {
      edges: { node: IssueNode }[];
    };
  };
}