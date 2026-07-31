import { afterEach, describe, expect, it, vi } from "vitest";

import plugin from "./plugin";
import type {
  DesktopPluginCodeActionContext,
  DesktopPluginCodeHostContext,
} from "@bitsentry/plugin-sdk";

function createGitHubIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: 101,
    number: 42,
    title: "API deploy failed",
    body: "Deploy job failed after checkout.",
    state: "open",
    html_url: "https://github.com/bitsentry-ai/monorepo/issues/42",
    created_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-06-01T00:05:00Z",
    comments: 3,
    labels: [{ name: "deploy" }],
    user: { login: "octocat" },
    ...overrides,
  };
}

const host: DesktopPluginCodeHostContext = {
  pluginRoot: "",
  entryPath: "",
  localPluginDirectories: [],
  reloadPlugins: () => Promise.resolve(),
};

function action(id: string) {
  const match = plugin.actions.find((candidate) => candidate.id === id);
  if (match === undefined) {
    throw new Error(`Missing GitHub plugin action: ${id}`);
  }
  return match;
}

function context(
  actionId: string,
  input: Record<string, unknown>,
): DesktopPluginCodeActionContext {
  return {
    pluginId: plugin.id,
    actionId,
    auth: {
      accessToken: "gh-token",
      apiBase: "https://github.example.com/api/v3",
    },
    input,
    host,
  };
}

describe("GitHub plugin package", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("declares a typed GitHub error-source code plugin", () => {
    expect(plugin).toMatchObject({
      id: "github",
      referenceRepositoryPath: ".repos/references/plugins/stackstorm-github",
      metadata: {
        dataSource: {
          sourceType: "github",
        },
      },
    });
    expect(plugin.actions.map((candidate) => candidate.id)).toEqual(
      expect.arrayContaining(["list_issues", "query_issues", "list_projects"]),
    );
  });

  it("executes list_issues through plugin code", async () => {
    vi.stubEnv("GITHUB_ALLOWED_BASE_URLS", "github.example.com");
    const fetchMock =
      vi.fn<(url: string, request?: RequestInit) => Promise<Response>>();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify([createGitHubIssue()]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await action("list_issues").execute(
      context("list_issues", {
        owner: "bitsentry-ai",
        repo: "monorepo",
        labels: ["deploy"],
        limit: 2,
        since: "2026-06-01T00:00:00Z",
      }),
    );

    expect(result).toMatchObject({
      status: 200,
      summary: "Fetched 1 GitHub issues.",
      data: {
        issues: [
          {
            externalIssueId: "bitsentry-ai/monorepo#42",
            projectIdentifier: "bitsentry-ai/monorepo",
            status: "open",
            title: "API deploy failed",
          },
        ],
        hasMore: false,
      },
    });

    const [url, request] = fetchMock.mock.calls[0] ?? [];
    expect(new URL(String(url)).pathname).toBe(
      "/api/v3/repos/bitsentry-ai/monorepo/issues",
    );
    expect(request?.headers).toMatchObject({
      Authorization: "Bearer gh-token",
      Accept: "application/vnd.github+json",
    });
    expect(request?.redirect).toBe("error");
  });

  it("keeps list_issues page size within the GitHub API limit", async () => {
    vi.stubEnv("GITHUB_ALLOWED_BASE_URLS", "github.example.com");
    const fetchMock =
      vi.fn<(url: string, request?: RequestInit) => Promise<Response>>();
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify(
          Array.from({ length: 100 }, (_, index) =>
            createGitHubIssue({
              id: 1000 + index,
              number: index + 1,
              title: `Issue ${String(index + 1)}`,
            }),
          ),
        ),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await action("list_issues").execute(
      context("list_issues", {
        owner: "bitsentry-ai",
        repo: "monorepo",
        limit: 100,
      }),
    );

    const [url] = fetchMock.mock.calls[0] ?? [];
    expect(new URL(String(url)).searchParams.get("per_page")).toBe("100");
    expect(result.data).toMatchObject({
      hasMore: true,
      nextCursor: "2",
    });
  });

  it("filters pull requests out of synced GitHub issue batches", async () => {
    vi.stubEnv("GITHUB_ALLOWED_BASE_URLS", "github.example.com");
    const fetchMock =
      vi.fn<(url: string, request?: RequestInit) => Promise<Response>>();
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify([
          createGitHubIssue(),
          createGitHubIssue({
            id: 202,
            number: 43,
            title: "Review plugin PR",
            html_url: "https://github.com/bitsentry-ai/monorepo/pull/43",
            pull_request: {
              url: "https://api.github.com/repos/bitsentry-ai/monorepo/pulls/43",
            },
          }),
        ]),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await action("list_issues").execute(
      context("list_issues", {
        owner: "bitsentry-ai",
        repo: "monorepo",
        limit: 10,
      }),
    );

    expect(result.data).toMatchObject({
      issues: [
        {
          externalIssueId: "bitsentry-ai/monorepo#42",
          type: "issue",
        },
      ],
      hasMore: false,
    });
  });

  it("pages past pull requests until the requested issue count is collected", async () => {
    vi.stubEnv("GITHUB_ALLOWED_BASE_URLS", "github.example.com");
    const fetchMock =
      vi.fn<(url: string, request?: RequestInit) => Promise<Response>>();
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(
            Array.from({ length: 3 }, (_, index) =>
              createGitHubIssue({
                id: 300 + index,
                number: 50 + index,
                title: `Review PR ${String(index + 1)}`,
                html_url: `https://github.example.com/bitsentry-ai/monorepo/pull/${String(50 + index)}`,
                pull_request: {
                  url: `https://api.github.com/repos/bitsentry-ai/monorepo/pulls/${String(50 + index)}`,
                },
              }),
            ),
          ),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            createGitHubIssue({
              id: 304,
              number: 53,
              title: "Issue after PR-heavy page",
            }),
            createGitHubIssue({
              id: 305,
              number: 54,
              title: "Second issue after PR-heavy page",
            }),
          ]),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await action("list_issues").execute(
      context("list_issues", {
        owner: "bitsentry-ai",
        repo: "monorepo",
        limit: 2,
      }),
    );

    expect(result.data).toMatchObject({
      issues: [
        {
          externalIssueId: "bitsentry-ai/monorepo#53",
          title: "Issue after PR-heavy page",
        },
        {
          externalIssueId: "bitsentry-ai/monorepo#54",
          title: "Second issue after PR-heavy page",
        },
      ],
      hasMore: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      new URL(String(fetchMock.mock.calls[1]?.[0])).searchParams.get("page"),
    ).toBe("2");
  });

  it("keeps pagination open when a short final page overfills the limit", async () => {
    vi.stubEnv("GITHUB_ALLOWED_BASE_URLS", "github.example.com");
    const fetchMock =
      vi.fn<(url: string, request?: RequestInit) => Promise<Response>>();
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            createGitHubIssue({ id: 400, number: 60, title: "First issue" }),
            ...Array.from({ length: 5 }, (_, index) =>
              createGitHubIssue({
                id: 401 + index,
                number: 61 + index,
                title: `Review PR ${String(index + 1)}`,
                html_url: `https://github.example.com/bitsentry-ai/monorepo/pull/${String(61 + index)}`,
                pull_request: {
                  url: `https://api.github.com/repos/bitsentry-ai/monorepo/pulls/${String(61 + index)}`,
                },
              }),
            ),
          ]),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            createGitHubIssue({ id: 406, number: 66, title: "Second issue" }),
            createGitHubIssue({ id: 407, number: 67, title: "Third issue" }),
            ...Array.from({ length: 4 }, (_, index) =>
              createGitHubIssue({
                id: 408 + index,
                number: 68 + index,
                title: `Review PR ${String(index + 6)}`,
                html_url: `https://github.example.com/bitsentry-ai/monorepo/pull/${String(68 + index)}`,
                pull_request: {
                  url: `https://api.github.com/repos/bitsentry-ai/monorepo/pulls/${String(68 + index)}`,
                },
              }),
            ),
          ]),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            createGitHubIssue({ id: 412, number: 72, title: "Fourth issue" }),
            createGitHubIssue({ id: 413, number: 73, title: "Fifth issue" }),
            createGitHubIssue({ id: 414, number: 74, title: "Sixth issue" }),
            createGitHubIssue({ id: 415, number: 75, title: "Seventh issue" }),
          ]),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await action("list_issues").execute(
      context("list_issues", {
        owner: "bitsentry-ai",
        repo: "monorepo",
        limit: 5,
      }),
    );

    expect(result.data).toMatchObject({
      issues: [
        { externalIssueId: "bitsentry-ai/monorepo#60" },
        { externalIssueId: "bitsentry-ai/monorepo#66" },
        { externalIssueId: "bitsentry-ai/monorepo#67" },
        { externalIssueId: "bitsentry-ai/monorepo#72" },
        { externalIssueId: "bitsentry-ai/monorepo#73" },
      ],
      hasMore: true,
      nextCursor: "4",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("aborts an in-flight API request when the parent operation is cancelled", async () => {
    vi.stubEnv("GITHUB_ALLOWED_BASE_URLS", "github.example.com");
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(
      (_url: string, request?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          requestSignal = request?.signal ?? undefined;
          requestSignal?.addEventListener(
            "abort",
            () => {
              reject(new Error("aborted"));
            },
            {
              once: true,
            },
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = action("list_issues").execute({
      ...context("list_issues", {
        owner: "bitsentry-ai",
        repo: "monorepo",
      }),
      operation: { signal: controller.signal },
    } as DesktopPluginCodeActionContext);

    await vi.waitFor(() => {
      expect(requestSignal).toBeDefined();
    });
    controller.abort();

    await expect(result).rejects.toThrow("aborted");
    expect(requestSignal?.aborted).toBe(true);
  });

  it("rejects non-HTTPS GitHub API bases before sending bearer credentials", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      action("list_issues").execute({
        ...context("list_issues", {
          owner: "bitsentry-ai",
          repo: "monorepo",
        }),
        auth: {
          accessToken: "gh-token",
          apiBase: "http://github.example.com/api/v3",
        },
      }),
    ).rejects.toThrow("GitHub API base URL must use https://");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects unallowlisted GitHub API bases before sending bearer credentials", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      action("list_issues").execute({
        ...context("list_issues", {
          owner: "bitsentry-ai",
          repo: "monorepo",
        }),
        auth: {
          accessToken: "gh-token",
          apiBase: "https://evil.example.com/api/v3",
        },
      }),
    ).rejects.toThrow(
      'GitHub API base URL "evil.example.com" is not in the allowlist',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps setup and auth mapping inside plugin code", async () => {
    expect(
      plugin.dataSource?.resolveSetup?.({
        pluginId: plugin.id,
        setupValues: {
          accessToken: "gh-token",
          owner: "bitsentry-ai",
          repos: ["monorepo", "runbooks"],
          apiBase: "https://github.example.com/api/v3",
        },
        host,
      }),
    ).toEqual({
      accessTokenRef: "gh-token",
      configuration: {
        orgSlug: "bitsentry-ai",
        projectIds: ["monorepo", "runbooks"],
        baseUrl: "https://github.example.com/api/v3",
      },
    });
  });
});
