# Template for creating Stash plugins source index

This template allows you to create a new repository with a few clicks with preconfigured GitHub action to publish your plugins source index. 
_This assumes you already know how to create plugins for Stash. If you don't, first read [this](https://docs.stashapp.cc/in-app-manual/plugins/#creating-plugins)._

## How to use it?

1. Click **Use this template** > **Create a new repository**. 
1. Choose a repository name and click **Create repository**.
1. Open **Settings** and head to **Pages**.
1. Under Build and deployment select the Source as GitHub Actions.

Now add your plugins to [plugins](/plugins) directory and they will be automatically published to the source index.

Source index URL: [`https://<your-username>.github.io/<repository-name>/main/index.yml`](https://<your-username>.github.io/<repository-name>/main/index.yml)

## Share your plugins

- [Create a new topic](https://discourse.stashapp.cc/t/-/33) for your plugin on the community forum.
- [Add your source index to the list](https://discourse.stashapp.cc/t/-/122) on the Stash community forum.

## License

The default license is set to [AGPL-3.0](/LICENCE). Before publishing any plugins you can change it.
## Plugin sync

The plugins in [plugins](/plugins) are copied from their own repos, listed in [plugins.txt](/plugins.txt). Don't edit them here: the next sync overwrites them.

- `./sync_plugins.sh` clones each repo and replaces `plugins/<name>` with its committed files.
- `./sync_plugins.sh --local ~/dev` uses your local checkouts instead. Handy for testing before you push.
- `.idea`, `.github`, `.gitignore` and `.gitattributes` are always left out. To leave out anything else, add it to the plugin repo's `.gitattributes` as `<path> export-ignore`.

The deploy workflow runs the sync, commits any changes and redeploys. It runs daily, on manual dispatch, and on a `plugin-updated` repository dispatch. To sync as soon as a plugin is pushed, add this workflow to the plugin repo as `.github/workflows/notify-repository.yml`. It needs a `REPOSITORY_TOKEN` secret: a fine-grained PAT with **Contents: read & write** on MRStashRepository.

```yaml
name: Notify plugin repository
on:
  push:
    branches: [main, master]
jobs:
  notify:
    runs-on: ubuntu-latest
    steps:
      - run: gh api repos/mrtoadx/MRStashRepository/dispatches -f event_type=plugin-updated
        env:
          GH_TOKEN: ${{ secrets.REPOSITORY_TOKEN }}
```
