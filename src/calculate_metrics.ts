import { graphql, GraphqlResponseError } from "@octokit/graphql";
import * as dotenv from "dotenv";
import { url_main } from "./url_handler";
import { LicenseInfo } from "./interfaces/LicenseInfo";
import { RepositoryResponse } from "./interfaces/RepositoryResponse";
import { CorrectnessInterface } from "./interfaces/correctnessinterface";
import * as git from "isomorphic-git";
import fs from "fs";
import http from "isomorphic-git/http/node";

const lgplCompatibleSpdxIds: string[] = [
  "LGPL-2.1-only",
  "LGPL-2.1-or-later",
  "MIT",
  "BSD-3-Clause",
  "BSD-2-Clause",
  "ISC",
  "Zlib",
  "Artistic-2.0",
  "GPL-2.0-only",
  "GPL-2.0-or-later",
  "GPL-3.0-only",
  "GPL-3.0-or-later",
  "LGPL-3.0-only",
  "LGPL-3.0-or-later",
  "MPL-2.0",
  "Unlicense",
  "CC0-1.0",
];

// Provide path to env file here
dotenv.config({ path: "../../githubapi.env" });
const githubToken = process.env.GITHUB_TOKEN;
const graphqlWithAuth = graphql.defaults({
  headers: {
    authorization: `token ${githubToken}`,
  },
});

// Modify logic if necessary, this is barebones implementation
function check_license_text(licenseText: string | undefined) {
  const normalizedText = licenseText?.toLowerCase();

  // List of licenses known to be compatible with LGPL v2.1
  const compatibleLicenses = [
    "mit license",
    "bsd 2-clause license",
    "bsd 3-clause license",
    "apache license, version 2.0",
    "lgpl",
    "gpl",
    "mozilla public license",
    "cc0",
  ];

  // Check if any compatible license is mentioned
  const mentionsCompatibleLicense = compatibleLicenses.some((license) =>
    normalizedText?.includes(license),
  );

  const permissivePhrases = [
    "permission is hereby granted, free of charge",
    "redistribute",
    "without restriction",
    "provided that the above copyright notice",
  ];
  const containsPermissivePhrases = permissivePhrases.some((phrase) =>
    normalizedText?.includes(phrase),
  );

  const incompatiblePhrases = [
    "not for use in",
    "not licensed for",
    "proprietary",
  ];
  const containsIncompatiblePhrases = incompatiblePhrases.some((phrase) =>
    normalizedText?.includes(phrase),
  );

  return (
    (mentionsCompatibleLicense || containsPermissivePhrases) &&
    !containsIncompatiblePhrases
  );
}

function getLatency(startTime: number): number {
  return Number(((performance.now() - startTime) / 1000).toFixed(3));
}

async function fetch_repo_info() {
  const url = process.argv[2];
  const obj = await url_main(url);
  const owner = obj?.repo_owner;
  const name = obj?.repo_name;

  return { owner, name };
}

async function calculate_rampup_metric(
  owner: string | undefined,
  name: string | undefined,
) {
  // use isomorphic-git to clone the repo
  const startTime = performance.now();
  await git.clone({
    fs,
    http,
    dir: "./repos/" + name,
    url: `https://github.com/${owner}/${name}.git`,
    singleBranch: true,
    depth: 1,
  });
  //perform analysis on the cloned repo for rampup time
  // Measure the time from when a developer first forks or clones the repository to when they submit their first pull request.

  // delete the cloned repo
  fs.rm(`./repos/${name}`, { recursive: true }, (err) => {
    if (err) {
      console.error(err);
    }
  });

  return { rampupScore: 0, rampup_latency: getLatency(startTime) };
}

async function calculate_correctness_metric(
  owner: string | undefined,
  name: string | undefined,
) {
  const startTime = performance.now();
  const query = `
  query {
    repository(owner: "${owner}", name: "${name}") {
      issues(states: OPEN) {
        totalCount
      }
      closedIssues: issues(states: CLOSED) {
        totalCount
      }
      pullRequests(states: OPEN) {
        totalCount
      }
      releases {
        totalCount
      }
      defaultBranchRef {
        target {
          ... on Commit {
            history(since: "${new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()}") {
              totalCount
            }
          }
        }
      }
    }
  }
  `;
  try {
    const response = await graphqlWithAuth<CorrectnessInterface>(query);
    const repo = response.repository;
    const openIssues = repo.issues.totalCount;
    const closedIssues = repo.closedIssues.totalCount;
    const openPullRequests = repo.pullRequests.totalCount;
    const releases = repo.releases.totalCount;
    const recentCommits = repo.defaultBranchRef.target.history.totalCount;
    //calculate issue ratio
    const issueRatio = closedIssues / (openIssues + closedIssues) || 0;
    // calculate pr ratio
    const prRatio = releases / (openPullRequests + releases) || 0;
    //calculate recent commit ratio (past 30 days and max at 1)
    const recentCommitRatio = Math.min(recentCommits / 30, 1);
    //calculate correctness score (ensuring its between 0 and 1)
    const correctnessScore = Number(Math.max(0, Math.min((issueRatio + prRatio + recentCommitRatio) / 3)).toFixed(3));
    return { correctnessScore: correctnessScore, correctness_latency: getLatency(startTime) };
  } catch (error) {
    if (error instanceof GraphqlResponseError) {
      console.log(error.message);
    } else {
      console.log(error);
    }
    return { licenseScore: 0, license_latency: 0 };
  }
}

async function calculate_responsiveness_metric(owner: string | undefined, name: string | undefined) {
  const startTime = performance.now();
  const query = `
  query {
    repository(owner: "${owner}", name: "${name}") {
      pullRequests(first: 100, states: [OPEN, MERGED, CLOSED]) {
        edges {
          node {
            createdAt
            closedAt
            mergedAt
            state
          }
        }
      }
      issues(first: 100, states: [OPEN, CLOSED]) {
        edges {
          node {
            createdAt
            closedAt
            state
          }
        }
      }
    }
  }
  `;

  try {
    const response = await graphqlWithAuth<RepositoryResponse>(query);
    const pullRequests = response.repository.pullRequests.edges;
    const issues = response.repository.issues.edges;

    //  Pull Requests
    let totalPrResponseTime = 0;
    let resolvedPrs = 0;

    pullRequests.forEach((pr: any) => {
      if (pr.node.closedAt || pr.node.mergedAt) {
        const createdAt = pr.node.createdAt
          ? new Date(pr.node.createdAt).getTime()
          : 0; //if undefined
        const closedOrMergedAt =
          pr.node.closedAt || pr.node.mergedAt
            ? new Date(pr.node.closedAt || pr.node.mergedAt).getTime()
            : 0; //if undefined!

        totalPrResponseTime += closedOrMergedAt - createdAt;
        resolvedPrs++;
      }
    });

    const avgPrResponseTime =
      resolvedPrs > 0 ? totalPrResponseTime / resolvedPrs : Infinity;

    // response time
    let totalIssueResponseTime = 0;
    let resolvedIssues = 0;

    issues.forEach((issue) => {
      if (issue.node.closedAt) {
        const createdAt = new Date(issue.node.createdAt).getTime();
        const closedAt = new Date(issue.node.closedAt).getTime();
        totalIssueResponseTime += closedAt - createdAt;
        resolvedIssues++;
      }
    });

    const avgIssueResponseTime =
      resolvedIssues > 0 ? totalIssueResponseTime / resolvedIssues : Infinity;

    // responsiveness score
    let responsivenessScore = 0;

    const maxAcceptableResponseTime = 86400000 * 7;
    if (
      avgPrResponseTime < maxAcceptableResponseTime &&
      avgIssueResponseTime < maxAcceptableResponseTime
    ) {
      responsivenessScore = 1;
    } else if (
      avgPrResponseTime < maxAcceptableResponseTime ||
      avgIssueResponseTime < maxAcceptableResponseTime
    ) {
      responsivenessScore = 0.7;
    } else {
      responsivenessScore = 0.3;
    }

    return {
      responsivenessScore,
      responsive_latency: getLatency(startTime),
    };
  } catch (error) {
    console.error("Error fetching repository data:", error);
    return { responsivenessScore: 0, responsive_latency: 0 };
  }
}

async function calculate_license_metric(
  owner: string | undefined,
  name: string | undefined,
) {
  const startTime = performance.now();
  const query = `
  query {
    repository(owner: "${owner}", name: "${name}") {
      licenseInfo {
        name
        spdxId
        url
        description
      }
      mainLicense: object(expression: "main:LICENSE") {
        ... on Blob {
          text
        }
      }
      masterLicense: object(expression: "master:LICENSE") {
        ... on Blob {
          text
        }
      }
    }
  }
  `;

  try {
    const response = await graphqlWithAuth<LicenseInfo>(query);
    const licenseInfo = response.repository.licenseInfo;
    const licenseText =
      response.repository.mainLicense?.text ||
      response.repository.masterLicense?.text;
    const licenseID = licenseInfo?.spdxId;
    const licenseName = licenseInfo?.name;

    let licenseScore = 0;
    if (licenseInfo == null || licenseID == null) {
      // No license info found
      return { licenseScore, license_latency: getLatency(startTime) };
    }

    if (
      licenseName === "Other" &&
      licenseText &&
      check_license_text(licenseText)
    ) {
      licenseScore = 1;
    } else if (lgplCompatibleSpdxIds.includes(licenseID)) {
      licenseScore = 1;
    }

    return { licenseScore, license_latency: getLatency(startTime) };
  } catch (error) {
    if (error instanceof GraphqlResponseError) {
      console.log(error.message);
    } else {
      console.log(error);
    }
    return { licenseScore: 0, license_latency: 0 };
  }
}

function calculate_net_score(
  licenseScore: number,
  rampupScore: number,
  correctnessScore: number,
  responsiveMaintenanceScore: number,
) {
  return (
    0.25 * licenseScore +
    0.25 * rampupScore +
    0.25 * correctnessScore +
    0.25 * responsiveMaintenanceScore
  );
}

async function main() {
  const { owner, name } = await fetch_repo_info();
  const { licenseScore, license_latency } = await calculate_license_metric(owner, name);
  const { responsivenessScore, responsive_latency } = await calculate_responsiveness_metric(owner, name);
  const { correctnessScore, correctness_latency } = await calculate_correctness_metric(owner, name);
  // const { rampupScore, rampup_latency } = await calculate_rampup_metric(owner, name);
  // build ndjson object
  const data = {
    licenseScore,
    license_latency,
    responsivenessScore,
    responsive_latency,
    correctnessScore,
    correctness_latency,
  };
  const ndjson = [
    JSON.stringify(data)
  ].join('\n');
  console.log(ndjson);
}

if (require.main === module) {
  main();
}
