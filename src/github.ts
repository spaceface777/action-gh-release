import { GitHub } from "@actions/github";
import { Config, releaseBody } from "./util";
import { lstatSync, readFileSync } from "fs";
import { getType } from "mime";
import { basename } from "path";
import { setFailed } from "@actions/core";

export interface ReleaseAsset {
  name: string;
  mime: string;
  size: number;
  data: Buffer;
}

export interface Release {
  id: number;
  upload_url: string;
  html_url: string;
  tag_name: string;
  body: string;
  target_commitish: string;
}

export class Releaser {
  github: GitHub;
  constructor(github: GitHub) {
    this.github = github;
  }

  getReleaseByTag(params: {
    owner: string;
    repo: string;
    tag: string;
  }): Promise<{ data: Release }> {
    return this.github.repos.getReleaseByTag(params);
  }

  createRelease(params: {
    owner: string;
    repo: string;
    tag_name: string;
    name: string;
    body: string | undefined;
    draft: boolean | undefined;
    prerelease: boolean | undefined;
  }): Promise<{ data: Release }> {
    return this.github.repos.createRelease(params);
  }

  updateRelease(params: {
    owner: string;
    repo: string;
    release_id: number;
    tag_name: string;
    target_commitish: string;
    name: string;
    body: string | undefined;
    draft: boolean | undefined;
    prerelease: boolean | undefined;
  }): Promise<{ data: Release }> {
    return this.github.repos.updateRelease(params);
  }

  async deleteRelease(params: {
    owner: string;
    repo: string;
    release_id: number;
    tag_name: string;
    target_commitish: string;
    name: string;
  }) {
    try {
      await this.github.repos.deleteRelease(params);
      await this.github.git.deleteRef({
        ...params,
        ref: `tags/${params.tag_name}`,
      });
    } catch (err) {
      console.log(`\n\nERROR deleting release:`);
      console.warn(err);
    }
  }

  allReleases(params: {
    owner: string;
    repo: string;
  }): AsyncIterableIterator<{ data: Release[] }> {
    const updatedParams = { per_page: 100, ...params };
    return this.github.paginate.iterator(
      this.github.repos.listReleases.endpoint.merge(updatedParams)
    );
  }
}

export const asset = (path: string): ReleaseAsset => {
  return {
    name: basename(path),
    mime: mimeOrDefault(path),
    size: lstatSync(path).size,
    data: readFileSync(path),
  };
};

export const mimeOrDefault = (path: string): string => {
  return getType(path) || "application/octet-stream";
};

export const upload = async (
  gh: GitHub,
  url: string,
  path: string
): Promise<any> => {
  let { name, size, mime, data } = asset(path);
  console.log(`⬆️ Uploading ${name}...`);
  return await gh.repos.uploadReleaseAsset({
    url,
    headers: {
      "content-length": size,
      "content-type": mime,
    },
    name,
    data,
  });
};

export const release = async (
  config: Config,
  releaser: Releaser
): Promise<Release> => {
  const [owner, repo] = config.github_repository.split("/");
  const tag =
    config.input_tag_name || config.github_ref.replace("refs/tags/", "");
  try {
    // you can't get a an existing draft by tag
    // so we must find one in the list of all releases
    if (config.input_draft) {
      for await (const response of releaser.allReleases({ owner, repo })) {
        let release = response.data.find((release) => release.tag_name === tag);
        if (release) {
          return release;
        }
      }
    }
    let existingRelease = await releaser.getReleaseByTag({ owner, repo, tag });
    if (config.input_attach_only) {
      return existingRelease.data
    }

    const release_id = existingRelease.data.id;
    const target_commitish = existingRelease.data.target_commitish;
    const tag_name = tag;
    const name = config.input_name || tag;
    const body = releaseBody(config);
    const draft = config.input_draft;
    const prerelease = config.input_prerelease;

    if (config.input_overwrite) {
      await releaser.deleteRelease({
        owner,
        repo,
        tag_name,
        release_id,
        target_commitish,
        name,
      });
      return await createRelease(config, releaser);
    } else {
      const release = await releaser.updateRelease({
        owner,
        repo,
        release_id,
        tag_name,
        target_commitish,
        name,
        body,
        draft,
        prerelease,
      });
      return release.data;
    }
  } catch (error) {
    if (error.status === 404) {
      if (config.input_attach_only) {
        console.error(`⚠️ No release found for tag ${config.github_ref}`)
        setFailed(`No release found for tag ${config.github_ref}`)
      }
      return await createRelease(config, releaser);
    } else {
      console.log(
        `⚠️ Unexpected error fetching GitHub release for tag ${config.github_ref}: ${error}`
      );
      throw error;
    }
  }
};

const createRelease = async (
  config: Config,
  releaser: Releaser
): Promise<Release> => {
  const [owner, repo] = config.github_repository.split("/");
  const tag_name =
    config.input_tag_name || config.github_ref.replace("refs/tags/", "");
  const name = config.input_name || tag_name;
  const body = releaseBody(config);
  const draft = config.input_draft;
  const prerelease = config.input_prerelease;
  console.log(`👩‍🏭 Creating new GitHub release for tag ${tag_name}...`);
  try {
    let release = await releaser.createRelease({
      owner,
      repo,
      tag_name,
      name,
      body,
      draft,
      prerelease,
    });
    return release.data;
  } catch (error) {
    // presume a race with competing metrix runs
    console.log(
      `⚠️ GitHub release failed with status: ${error.status}, retrying...`
    );
    return createRelease(config, releaser);
  }
};
