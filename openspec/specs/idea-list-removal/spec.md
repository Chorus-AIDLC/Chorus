# idea-list-removal Specification

## Purpose
TBD - created by archiving change remove-idea-list-page. Update Purpose after archive.
## Requirements
### Requirement: Idea List page is removed from the UI

The standalone Idea List page SHALL NOT be a reachable route. The project
sidebar navigation SHALL NOT contain an `Ideas` entry, and the Dashboard
(Overview) SHALL be the single entry point for browsing and managing ideas.

#### Scenario: No Ideas item in the project sidebar

- **WHEN** a user views a project's sidebar navigation
- **THEN** there is no `Ideas` navigation item
- **AND** the items shown are Overview, Documents, Proposals, Tasks, and Activity

#### Scenario: The ideas route no longer renders a list page

- **WHEN** a user navigates to `/projects/{projectUuid}/ideas`
- **THEN** no idea-list page is rendered
- **AND** the request is redirected to the Dashboard (see the redirect requirement)

### Requirement: RESTful idea URLs redirect into the Dashboard

The two RESTful idea URLs SHALL be preserved as redirects rather than 404s, so
shared links and bookmarks keep working. The redirect SHALL use HTTP 308
(permanent, method-preserving) and SHALL be performed in middleware.

#### Scenario: List URL redirects to the Dashboard

- **WHEN** a request hits `/projects/{projectUuid}/ideas`
- **THEN** it is redirected with status 308 to `/projects/{projectUuid}/dashboard`

#### Scenario: Idea detail URL redirects to the Dashboard side panel

- **WHEN** a request hits `/projects/{projectUuid}/ideas/{ideaUuid}`
- **THEN** it is redirected with status 308 to `/projects/{projectUuid}/dashboard?panel={ideaUuid}`

#### Scenario: Legacy query-param idea link collapses to one hop

- **WHEN** a request hits `/projects/{projectUuid}/ideas?idea={ideaUuid}`
- **THEN** it is redirected directly to `/projects/{projectUuid}/dashboard?panel={ideaUuid}`
- **AND** it does not chain through `/projects/{projectUuid}/ideas/{ideaUuid}` first

### Requirement: Internal idea links target the Dashboard directly

Internal navigation that previously linked to the Idea List page SHALL link to
the Dashboard address directly, rather than relying on the redirect.

#### Scenario: Global search opens an idea in the Dashboard panel

- **WHEN** a user selects an idea result in global search
- **THEN** the app navigates to `/projects/{projectUuid}/dashboard?panel={ideaUuid}`

#### Scenario: Idea notifications open the Dashboard panel

- **WHEN** a user opens a notification whose target is an idea
- **THEN** the link points to the project Dashboard with `?panel={ideaUuid}`

#### Scenario: Dashboard "Total Ideas" stat links to the Dashboard

- **WHEN** a user clicks the "Total Ideas" stat card on the Dashboard
- **THEN** the link points to the project Dashboard (not the removed `/ideas` page)

