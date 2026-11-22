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
the source: after changing it, copy it there unchanged. Its `TemplateURL`
already names the published copy.
