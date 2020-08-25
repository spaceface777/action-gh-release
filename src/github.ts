import { GitHub } from "@actions/github";
import { Config, releaseBody } from "./util";
import { lstatSync, readFileSync } from "fs";
import { getType } from "mime";
import { basename } from "path";

export interface ReleaseAsset {
  name: string;
  mime: string;
  size: number;
  file: Buffer;
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

  deleteRelease(params: {
    owner: string;
    repo: string;
    tag_name: string;
    release_id: number;
  }) : Promise<{ data: Release }> {
    try {
      const d = this.github.repos.deleteRelease(params);
      this.github.git.deleteRef({
        ...params,
        ref: `refs/tags/${params.tag_name}`,
      });
      return d;
    } catch(err) {
      console.log('\n\nERROR')
      console.log(err)
      return Promise.resolve({ data: {} as Release }) // TODO
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
    file: readFileSync(path),
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
  let { name, size, mime, file } = asset(path);
  console.log(`⬆️ Uploading ${name}...`);
  return await gh.repos.uploadReleaseAsset({
    url,
    headers: {
      "content-length": size,
      "content-type": mime,
    },
    name,
    file,
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

    const release_id = existingRelease.data.id;
    const target_commitish = existingRelease.data.target_commitish;
    const tag_name = tag;
    const name = config.input_name || tag;
    const body = releaseBody(config);
    const draft = config.input_draft;
    const prerelease = config.input_prerelease;

    if (config.input_overwrite) {
      console.warn('\n\n1\n')
      await releaser.deleteRelease({
        owner,
        repo,
        tag_name,
        release_id,
      });
      console.warn('\n\n2\n')
      const rel = await createRelease(config, releaser);
      console.warn('\n\n3\n')
      return rel
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
