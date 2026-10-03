---
title: "Chorus v0.21.0: Project Access Control and Agent Failure Diagnostics"
description: "How should teams manage access when several projects share a workspace? When a background agent fails, how can its conversation help identify the cause?"
date: 2026-10-03
lang: en
postSlug: chorus-v0.21.0-release
---

# Chorus v0.21.0: Project Access Control and Agent Failure Diagnostics

Teams sharing a workspace often have different access requirements for their projects. Internal tools may be open to everyone in the company, while planning or client projects need a defined set of participants.

As the number of projects and roles grows, the system needs to establish who can view, edit, and administer each project. The same rules must apply to agents working on behalf of those users.

Chorus v0.21.0 introduces private projects and project groups with role-based access and inherited permissions. It also adds persistent diagnostics for agent startup and execution failures directly in conversations.

## Project access control

Projects can be created as public or private. Public projects retain the existing company-wide collaboration model. Private projects grant access through membership.

Private projects support three member roles:

| Role | Permissions |
| --- | --- |
| Viewer | View project content |
| Editor | Edit content, approve Proposals, and verify Tasks |
| Admin | All Editor permissions, plus membership and visibility management |

Members are managed in the Access tab of project settings. Viewers see a read-only notice, and editing actions are restricted.

Agents inherit their owner's project access and remain subject to their own operation permissions. Both project authorization and agent permissions determine which operations an agent can perform.

Access checks cover project pages, APIs, and MCP tools. Search results, notifications, and live messages are also filtered by current project permissions, keeping authorization consistent across entry points.

## Project group membership and inherited access

Client delivery or product development can involve several related projects, such as backend services, client applications, and release preparation. When these projects share a team, group membership reduces the need to configure each project individually.

v0.21.0 adds public and private visibility to project groups, along with Viewer, Editor, and Admin roles. Child projects inherit group permissions as they change.

Projects can also grant access independently. The effective role is the higher of the group role and the project role. A group Viewer with an Editor grant on one project can edit that project. Changing group membership does not remove independent project grants.

Private groups contain only private projects. Making a public group private also makes its public child projects private. Making a private group public preserves each child's existing visibility.

Visibility changes and project moves that affect access provide a preview of permission changes and the number of affected people before confirmation. When a private project is detached, or a group is deleted while retaining its projects, existing access is preserved as project membership.

Administrators can therefore review the access consequences before changing how projects are organized.

## Agent failure diagnostics in conversations

A background agent may stop because a command cannot start, a working directory is unavailable, or execution fails. Some failures happen before the agent produces a reply. A failed status alone offers little information about the cause.

v0.21.0 stores startup and execution diagnostics on the corresponding conversation turn. The chat displays an error summary, with expandable details for backend errors, exit codes, and termination signals.

Failed turns can display diagnostics even when they contain no agent reply. The information persists with the conversation and remains available when it is reopened. Historical failures without stored diagnostics explicitly indicate that details are unavailable.

## Operations and upgrade improvements

This release also includes three maintenance improvements:

- **Linux daemon persistence**: The systemd installation flow checks and attempts to enable lingering, allowing the service to continue after logout and start at boot. Authorization is noninteractive and time-limited. If permission is denied, the installer provides a manual repair command. `--no-linger` skips this step.
- **Dependencies and database migrations**: Application and build dependencies, including Next.js and React, receive security updates. Docker migration tooling now uses the same Prisma version as the application.
- **Installation guidance**: Outdated version pins are removed from installation pages, documentation, and retired installation entry points, so ordinary installation commands obtain the latest published version.

Project and group authorization allow teams to manage different access requirements within one workspace. Conversation diagnostics provide the corresponding visibility into failed agent runs.

## Upgrading

For self-hosted deployments, update the Chorus server and apply database migrations first. Existing projects and project groups remain public after upgrading.

To update the CLI and configured plugins:

```bash
npm install -g @chorus-aidlc/chorus@0.21.0
chorus upgrade --plugins
chorus daemon restart
```

`chorus upgrade` uses the workflow introduced in v0.20.0. `--plugins` refreshes Claude Code, Codex, Kiro, and Pi integrations registered in the default daemon configuration. Update the agent CLIs separately. Kiro templates are served by Chorus, so update the server before refreshing Kiro.

All six plugins and four published npm packages use version **0.21.0**.
