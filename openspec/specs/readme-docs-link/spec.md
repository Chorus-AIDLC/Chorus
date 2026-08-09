# readme-docs-link Specification

## Purpose
Ensure every README locale (en / zh / ko / ja) links prominently to the live documentation site near its header, without disturbing the existing banner, tagline, language switch, or badges.
## Requirements
### Requirement: README links to the documentation site

Every README locale (README.md, README.zh.md, README.ko.md, README.ja.md) SHALL carry a prominent link to the live documentation site `https://doc.chorus-ai.dev`, placed near the top (adjacent to the language-switch line), with a locale-appropriate label.

#### Scenario: Reader opens any localized README

- **WHEN** a visitor reads any of the four README locales on GitHub
- **THEN** a "Documentation"-style link (localized label) to `https://doc.chorus-ai.dev` is visible near the header, above the main content

#### Scenario: Existing header elements preserved

- **WHEN** the docs link is added
- **THEN** the existing banner image, tagline, language-switch line, and badges block remain intact and correctly rendered

