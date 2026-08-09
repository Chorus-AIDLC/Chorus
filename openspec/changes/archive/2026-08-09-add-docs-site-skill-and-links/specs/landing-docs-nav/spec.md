## ADDED Requirements

### Requirement: Landing page navigation includes a Documentation entry

The landing page navigation SHALL include a "Documentation" entry linking to the live documentation site, in both the desktop nav links and the mobile menu, with `en` and `zh` i18n copy (`nav.docs`). The entry SHALL open in a new tab and its target SHALL be language-aware: the `en` landing links to `https://doc.chorus-ai.dev`, the `zh` landing links to `https://doc.chorus-ai.dev/zh`.

#### Scenario: Visitor clicks Documentation on the English landing page

- **WHEN** a visitor on the `en` landing page clicks the Documentation nav entry
- **THEN** the docs site root `https://doc.chorus-ai.dev` opens in a new browser tab

#### Scenario: Visitor clicks Documentation on the Chinese landing page

- **WHEN** a visitor on the `zh` landing page clicks the Documentation nav entry
- **THEN** the Chinese docs section `https://doc.chorus-ai.dev/zh` opens in a new browser tab

#### Scenario: Documentation entry present on mobile

- **WHEN** the landing page is viewed at a mobile width and the menu is opened
- **THEN** the Documentation entry appears in the mobile menu with the localized `nav.docs` label
