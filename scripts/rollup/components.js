import {createFilter} from '@rollup/pluginutils';
import jsonPlugin from "@rollup/plugin-json";
import {Octokit} from "@octokit/rest";
import packageJson from "package-json";
import {Projects} from "@gitbeaker/node";
import {DiskCache} from "@lsdsoftware/simple-cache";
import fs from "fs";

export default function components(options = {}) {
    const filter = createFilter(options.include, options.exclude);
    let githubConfig = {};
    let gitlabConfig = {};
    if (options.githubAuth) {
        githubConfig = {auth: options.githubAuth};
    }
    if (options.gitlabAuth) {
        gitlabConfig = {token: options.gitlabAuth};
    }
    const github = new Octokit(githubConfig);
    const gitlab = new Projects(gitlabConfig);

    if (!fs.existsSync('.cache')) fs.mkdirSync('.cache');
    const cache = new DiskCache('.cache', 24 * 60 * 60 * 1000, 60 * 60 * 1000);

    /**
     * Search for data in cache, if not found calculate it
     * @param {string} cacheKey The Cache key to use to identify the data
     * @param {function} valueGetter The function to get the data if it does exists in cache
     * @return {Promise<any>}
     */
    async function getData(cacheKey, valueGetter) {
        cacheKey = cacheKey
            .replace('@', '--AT--')
            .replace('/', '--SLASH--');

        try {
            const cacheData = await cache.get(cacheKey);
            if (cacheData !== undefined) return JSON.parse(cacheData.data);
        } catch (e) {
            // Do nothing
        }
        const generatedValue = await valueGetter();
        cache.set(cacheKey, {data: JSON.stringify(generatedValue), key: cacheKey});
        return generatedValue;
    }

    /**
     * Get information about a NPM Package
     * @param {string} packageName The name of the NPM package
     * @return {Promise<{description: null|string, tags: array, url: null|string, repo: null|string, title: null|string}>}
     */
    async function getNpmInfo(packageName) {
        return await getData(`npm-${packageName}`, async () => {
            try {
                const npmInfo = await packageJson(packageName, {fullMetadata: true});
                let repo = (npmInfo.repository && npmInfo.repository.url || '')
                    .replace(/^git\+/, '')
                    .replace(/\.git$/, '');
                if (repo === '') repo = null
                return {
                    description: npmInfo.description,
                    tags: npmInfo.keywords,
                    url: npmInfo.homepage,
                    repo,
                    title: npmInfo.name
                };
            } catch (e) {
                return {
                    description: null,
                    tags: [],
                    repo: null,
                    url: null,
                    title: null
                };
            }
        });
    }

    /**
     * Get Github information from an URL
     * @param {string|null} [url] The URL to lookup
     * @return {Promise<{description: null|string, stars: null|number, title: null|string, url: null|string}>}
     */
    async function getGithubInfo(url) {
        const emptyResponse = {
            stars: null,
            description: null,
            title: null,
            url: null
        }
        if (undefined === url || url === null) return emptyResponse;
        if (
            !url.startsWith('https://github.com/')
            && !url.startsWith('ssh://git@github.com/')
            && !url.startsWith('git://github.com/')
        ) return emptyResponse;

        const data = /^(?:https|ssh|git):\/\/(?:git@)?github\.com\/([^\/]+)\/([^\/]+)/.exec(url);
        const owner = data[1];
        const repo = data[2];

        return await getData(`github-${owner}-${repo}`, async () => {
            try {
                const githubInfo = await github.repos.get({owner, repo})
                    .catch(e => {return {
                        data: {
                            stargazers_count: null,
                            description: null,
                            name: null,
                            homepage: null
                        }
                    }});

                return {
                    stars: githubInfo.data.stargazers_count,
                    description: githubInfo.data.description,
                    title: githubInfo.data.name,
                    url: githubInfo.data.homepage
                };
            } catch (e) {
                return emptyResponse;
            }
        });
    }

    /**
     * Get Gitlab information from an URL
     * @param {string|null} [url] The URL to lookup
     * @return {Promise<{description: null|string, stars: null|number, title: null|string, url: null|string, tags: array}>}
     */
    async function getGitlabInfo(url) {
        const emptyResponse = {
            stars: null,
            description: null,
            title: null,
            url: null,
            tags: []
        };
        if (undefined === url || url === null || !url.startsWith('https://gitlab.com/')) return emptyResponse;

        const data = /^https:\/\/gitlab\.com\/([^\/]+)\/([^\/]+)/.exec(url);
        const owner = data[1];
        const repo = data[2];

        return await getData(`gitlab-${owner}-${repo}`, async () => {
            try {
                const gitlabInfo = await gitlab.show(`${owner}/${repo}`)
                    .catch(e => { return {
                        star_count: null,
                        description: null,
                        name: null,
                        web_url: null,
                        tag_list: []
                    }});

                return {
                    stars: gitlabInfo.star_count,
                    description: gitlabInfo.description,
                    title: gitlabInfo.name,
                    url: gitlabInfo.web_url,
                    tags: gitlabInfo.tag_list
                };
            } catch (e) {
                return emptyResponse;
            }
        });
    }

    /**
     * Merge two data object.
     * On key tags, filter all key that include "svelte"
     * @param {object} base
     * @param {object} additional
     * @return {object}
     */
    function merge(base, additional) {
        let newData = Object.assign({}, base);

        Object.entries(additional).forEach(([key, value]) => {
            if (value === undefined || value === null || value === [] || value === '') {
                return;
            }
            if (!Object.keys(newData).includes(key)) {
                newData[key] = value;
                return;
            }
            if (key === 'tags' && Array.isArray(value)) {
                newData.tags = [...(newData.tags || []), ...value].filter(tag => !tag.includes('svelte'));
            }

        })

        return newData;
    }

    function writeProgress(position, total) {
        process.stdout.clearLine();
        process.stdout.cursorTo(0);
        const percent = total > 0 ? Math.round(position / total * 1000) / 10 : '---.-';
        process.stdout.write(`Processing component \u001B[36m${position}\u001B[0m/${total} (${percent}%)`);
    }

    async function updateItem(item) {
        if (Object.keys(item).includes('npm')) {
            item = merge(item, await getNpmInfo(item.npm));
        }

        item = merge(item, await getGithubInfo(item.repo || item.url));
        item = merge(item, await getGitlabInfo(item.repo || item.url));

        return item;
    }

    return {
        name: 'components',

        async transform(json, id) {
            if (!id.endsWith('src/pages/components/components.json') || !filter(id)) return null;

            process.stdout.write('Starting...');
            const startAt = (new Date()).getTime();

            try {
                let parsed = JSON.parse(json);
                const chunkSize = 10;
                for (let i = 0; i < Math.ceil(parsed.length/chunkSize); i++) {

                    let tasks = parsed.slice(i*chunkSize, (i+1)*chunkSize).map(item => updateItem(item))
                    let promise = await Promise.allSettled(tasks);

                    parsed.splice(i*chunkSize, chunkSize, ...promise.map(result => result.value))

                    writeProgress(Math.min(parsed.length, (i+1)*chunkSize), parsed.length);
                }

                const endAt = (new Date()).getTime();
                let duration = endAt - startAt;
                duration = ' - Done in \u001B[33m' + (duration < 1000 ? `${duration}\u001B[0m ms` : `${Math.round(duration/1000)}\u001B[0m s`);
                process.stdout.write(duration + "\n");

                return jsonPlugin().transform(JSON.stringify(parsed), id);
            } catch (err) {
                const message = 'Could not parse JSON file';
                const position = parseInt(/[\d]/.exec(err.message)[0], 10);
                this.warn({message, id, position});
                return null;
            }
        }
    };
}