# Platforms

One folder per platform Berthward is packaged for. The image is the same
everywhere; what differs is how a platform installs it.

| Folder | What is in it |
|---|---|
| `unraid/` | `template.xml`, the Community Applications template |

Planned: TrueNAS, plain Docker (a compose file) and Home Assistant.

## Unraid: where Community Applications reads the template

Community Applications does not read this repository. It reads
[thecode/unraid-docker-templates](https://github.com/thecode/unraid-docker-templates),
where the template is published as `templates/berthward.xml`. The file here is
the source, and its `TemplateURL` already names the published copy.

The copy is made by the `template` job of the publish workflow:

- **On a release**, after the image is pushed, so a new template field reaches
  Community Applications together with the image that understands it.
- **By hand**, for a change of wording that should not wait: Actions → *Build
  and push Docker image* → **Run workflow**, with the template box ticked. It
  copies the file from `main`.

The job pushes with a deploy key of the templates repository, kept here as the
secret `TEMPLATES_DEPLOY_KEY`. Do not edit the published copy by hand: the
next release overwrites it.
