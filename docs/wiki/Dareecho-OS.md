# Dareecho OS · Development

Rein's Dareecho tier opens up the machine: it learns what a machine is before you replace anything on it, copies the files that are yours before an OS change, and installs a real software factory next to your agent. Nothing in this tier is required for the terminal workflow.

This page is the OS development surface. It is a development path — plan is read-only, and prepare writes only to the new directory you choose. Neither one partitions disks, installs an operating system, or enables a background service.

## 01 Learn and keep your files first

Before any replacement work, run the learn pass and the export pass. They are covered in [Dareecho Learn + export](https://github.com/Zermo/rein-agent/wiki/Dareecho-export). The learn pass changes nothing; the export pass copies and never deletes a source.

## 02 Plan

Plan assesses this machine and shows the installation gates. It is read-only.

PLAN THIS MACHINE
Copy
rein os plan

For the ChromeOS image path instead of the host path:

PLAN FOR AN IMAGE
Copy
rein os plan --mode image

Add `--json` for scripts.

## 03 Prepare a kit

Prepare stages a pinned overlay kit into a new directory you name. It does not install anything on this machine.

STAGE THE OMARCHY KIT
Copy
rein os prepare --output /path/to/new-kit

The default target is the Omarchy VM overlay. For the ChromeOS userland kit:

STAGE THE CHROMEOS KIT
Copy
rein os prepare --output /path/to/new-kit --target chromeos

Use the kit's instructions on a disposable VM before testing physical hardware.

## 04 Run a software factory

Mastra Factory is the third tier of the machine. It is a separate, wrapped service — same name, same UI, same icon as upstream. Its install, profiles, and model wiring are in [Mastra Factory](https://github.com/Zermo/rein-agent/wiki/Mastra-Factory).

## 05 Rain and skins

The rain motif and the Rainmeter-model skins are preview and staging tools. They render to the terminal or to a target directory; they do not activate a desktop theme.

RAIN (STATIC)
Copy
rein os rain

RAIN (ANIMATED, NEEDS A TTY)
Copy
rein os rain --animate

SKIN RENDER
Copy
rein os skin render <file|dir>

SKIN INSTALL (REFUSES TO OVERWRITE)
Copy
rein os skin install <dir>

`--frames` animates a skin on the alternate screen and needs a TTY. `REIN_REDUCED_MOTION=1` keeps previews and skins still.
