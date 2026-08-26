"use client";

import { useTranslations } from "next-intl";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { ChevronDown } from "lucide-react";
import { CodeBlock } from "./CodeBlock";

interface AgentInstallGuideProps {
  apiKey: string | null;
}

export function AgentInstallGuide({ apiKey }: AgentInstallGuideProps) {
  const t = useTranslations("onboarding");
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const displayKey = apiKey || "<YOUR_API_KEY>";

  // Optional step, identical across every `chorus agents add` tab (Claude Code /
  // Codex / Kiro / OpenCode): pick the default agent the chorus CLI acts as. dsh
  // omits it (its profile is seeded into $DSH_HOME/.env and loaded by dsh);
  // openClaw / other don't run `chorus agents add`, so no CLI profile applies.
  const profileStep = (
    <div>
      <h3 className="mb-2 text-sm font-medium text-foreground">
        {t("install.profileStep.title")}
      </h3>
      <CodeBlock language="bash" code={`export CHORUS_AGENT_PROFILE="<agent-uuid>"`} />
      <p className="mt-2 text-xs text-muted-foreground">
        {t("install.profileStep.desc")}
      </p>
    </div>
  );

  // Claude Code ONLY: `chorus agents add` writes the connection env into the
  // user-global ~/.claude/settings.json, so — unlike the other harnesses — there is
  // no manual `export` / `CHORUS_AGENT_PROFILE` step. Show WHAT is written and WHERE
  // instead of the profile-export step.
  const settingsWritesStep = (
    <div>
      <h3 className="mb-2 text-sm font-medium text-foreground">
        {t("install.claudeCode.writesTitle")}
      </h3>
      <CodeBlock
        language="json"
        code={`// ~/.claude/settings.json\n{\n  "env": {\n    "CHORUS_URL": "${origin}",\n    "CHORUS_API_KEY": "cho_…",\n    "CHORUS_AGENT_PROFILE": "<agent-uuid>"\n  }\n}`}
      />
      <p className="mt-2 text-xs text-muted-foreground">
        {t("install.claudeCode.writesDesc")}
      </p>
    </div>
  );

  return (
    <Card className="w-full">
      <CardContent className="p-6">
        <Tabs defaultValue="claude-code" className="w-full">
          <TabsList className="w-full justify-start overflow-x-auto">
            <TabsTrigger value="claude-code" className="shrink-0">
              {t("install.tabs.claudeCode")}
            </TabsTrigger>
            <TabsTrigger value="codex" className="shrink-0">
              {t("install.tabs.codex")}
            </TabsTrigger>
            <TabsTrigger value="kiro" className="shrink-0">
              {t("install.tabs.kiro")}
            </TabsTrigger>
            <TabsTrigger value="dsh" className="shrink-0">
              {t("install.tabs.dsh")}
            </TabsTrigger>
            <TabsTrigger value="opencode" className="shrink-0">
              {t("install.tabs.opencode")}
            </TabsTrigger>
            <TabsTrigger value="openclaw" className="shrink-0">
              {t("install.tabs.openClaw")}
            </TabsTrigger>
            <TabsTrigger value="other" className="shrink-0">
              {t("install.tabs.other")}
            </TabsTrigger>
          </TabsList>

          {/* Claude Code Tab */}
          <TabsContent value="claude-code" className="mt-4 space-y-4">
            <div>
              <h3 className="mb-2 text-sm font-medium text-foreground">
                {t("install.claudeCode.step1Title")}
              </h3>
              <CodeBlock
                language="bash"
                code={`export CHORUS_URL="${origin}"\nexport CHORUS_API_KEY="${displayKey}"`}
              />
              <p className="mt-2 text-xs text-muted-foreground">
                {t("install.claudeCode.step1Tip")}
              </p>
            </div>

            <div>
              <h3 className="mb-2 text-sm font-medium text-foreground">
                {t("install.claudeCode.step2Title")}
              </h3>
              <CodeBlock
                language="bash"
                code={`npm install -g @chorus-aidlc/chorus@0.17.0\nchorus agents add --agents claude`}
              />
              <p className="mt-2 text-xs text-muted-foreground">
                {t("install.claudeCode.step2Tip")}
              </p>
            </div>

            {settingsWritesStep}
          </TabsContent>

          {/* Codex Tab */}
          <TabsContent value="codex" className="mt-4 space-y-4">
            <div>
              <h3 className="mb-2 text-sm font-medium text-foreground">
                {t("install.codex.step1Title")}
              </h3>
              <CodeBlock
                language="bash"
                code={`export CHORUS_URL="${origin}"\nexport CHORUS_API_KEY="${displayKey}"`}
              />
              <p className="mt-2 text-xs text-muted-foreground">
                {t("install.codex.step1Tip")}
              </p>
            </div>

            <div>
              <h3 className="mb-2 text-sm font-medium text-foreground">
                {t("install.codex.step2Title")}
              </h3>
              <CodeBlock
                language="bash"
                code={`npm install -g @chorus-aidlc/chorus@0.17.0\nchorus agents add --agents codex`}
              />
              <p className="mt-2 text-xs text-muted-foreground">
                {t("install.codex.step2Tip")}
              </p>
            </div>

            {profileStep}
          </TabsContent>

          {/* Kiro Tab */}
          <TabsContent value="kiro" className="mt-4 space-y-4">
            <div>
              <h3 className="mb-2 text-sm font-medium text-foreground">
                {t("install.kiro.step1Title")}
              </h3>
              <CodeBlock
                language="bash"
                code={`export CHORUS_URL="${origin}"\nexport CHORUS_API_KEY="${displayKey}"`}
              />
              <p className="mt-2 text-xs text-muted-foreground">
                {t("install.kiro.step1Tip")}
              </p>
            </div>

            <div>
              <h3 className="mb-2 text-sm font-medium text-foreground">
                {t("install.kiro.step2Title")}
              </h3>
              <CodeBlock
                language="bash"
                code={`npm install -g @chorus-aidlc/chorus@0.17.0\nchorus agents add --agents kiro`}
              />
              <p className="mt-2 text-xs text-muted-foreground">
                {t("install.kiro.step2Tip")}
              </p>
            </div>

            {profileStep}
          </TabsContent>

          {/* dsh Tab */}
          <TabsContent value="dsh" className="mt-4 space-y-4">
            <div>
              <h3 className="mb-2 text-sm font-medium text-foreground">
                {t("install.dsh.step1Title")}
              </h3>
              <CodeBlock
                language="bash"
                code={`export CHORUS_URL="${origin}"\nexport CHORUS_API_KEY="${displayKey}"`}
              />
              <p className="mt-2 text-xs text-muted-foreground">
                {t("install.dsh.step1Tip")}
              </p>
            </div>

            <div>
              <h3 className="mb-2 text-sm font-medium text-foreground">
                {t("install.dsh.step2Title")}
              </h3>
              <CodeBlock
                language="bash"
                code="dsh plugin --profile <name> add @chorus-aidlc/chorus-dsh -w"
              />
              <p className="mt-2 text-xs text-muted-foreground">
                {t("install.dsh.step2Tip", { name: "<name>" })}
              </p>
            </div>

            <div>
              <h3 className="mb-2 text-sm font-medium text-foreground">
                {t("install.dsh.step3Title")}
              </h3>
              <CodeBlock
                language="bash"
                code={`npm install -g @chorus-aidlc/chorus@0.17.0\nchorus agents add --agents dsh --dsh-profile <name>`}
              />
              <p className="mt-2 text-xs text-muted-foreground">
                {t("install.dsh.step3Tip", { name: "<name>" })}
              </p>
            </div>

            <div>
              <h3 className="mb-2 text-sm font-medium text-foreground">
                {t("install.dsh.step4Title")}
              </h3>
              <p className="text-sm text-muted-foreground">
                {t("install.dsh.step4Desc", { name: "<name>" })}
              </p>
            </div>
          </TabsContent>

          {/* OpenCode Tab */}
          <TabsContent value="opencode" className="mt-4 space-y-4">
            <div>
              <h3 className="mb-2 text-sm font-medium text-foreground">
                {t("install.opencode.step1Title")}
              </h3>
              <CodeBlock
                language="bash"
                code={`export CHORUS_URL="${origin}"\nexport CHORUS_API_KEY="${displayKey}"`}
              />
              <p className="mt-2 text-xs text-muted-foreground">
                {t("install.opencode.step1Tip")}
              </p>
            </div>

            <div>
              <h3 className="mb-2 text-sm font-medium text-foreground">
                {t("install.opencode.step2Title")}
              </h3>
              <CodeBlock
                language="bash"
                code={`npm install -g @chorus-aidlc/chorus@0.17.0\nchorus agents add --agents opencode`}
              />
              <p className="mt-2 text-xs text-muted-foreground">
                {t("install.opencode.step2Tip")}
              </p>
            </div>

            {profileStep}

            {/* Troubleshooting collapsible */}
            <Collapsible>
              <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
                <ChevronDown className="size-4 transition-transform duration-200 [[data-state=open]>&]:rotate-180" />
                {t("install.opencode.troubleshootingTitle")}
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="mt-2 space-y-2">
                  <div className="rounded-md border border-amber-500/20 bg-amber-500/5 p-3">
                    <p className="text-sm font-medium text-amber-600 dark:text-amber-400">
                      {t("install.opencode.issueCache.title")}
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {t("install.opencode.issueCache.fix")}
                    </p>
                  </div>
                  <div className="rounded-md border border-amber-500/20 bg-amber-500/5 p-3">
                    <p className="text-sm font-medium text-amber-600 dark:text-amber-400">
                      {t("install.opencode.issueEnv.title")}
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {t("install.opencode.issueEnv.fix")}
                    </p>
                  </div>
                  <div className="rounded-md border border-amber-500/20 bg-amber-500/5 p-3">
                    <p className="text-sm font-medium text-amber-600 dark:text-amber-400">
                      {t("install.opencode.issueCheckin.title")}
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {t("install.opencode.issueCheckin.fix")}
                    </p>
                  </div>
                </div>
              </CollapsibleContent>
            </Collapsible>
          </TabsContent>

          {/* OpenClaw Tab */}
          <TabsContent value="openclaw" className="mt-4 space-y-4">
            <div>
              <h3 className="mb-2 text-sm font-medium text-foreground">
                {t("install.openClaw.step1Title")}
              </h3>
              <CodeBlock
                language="bash"
                code="openclaw plugins install @chorus-aidlc/chorus-openclaw-plugin"
              />
            </div>

            <div>
              <h3 className="mb-2 text-sm font-medium text-foreground">
                {t("install.openClaw.step2Title")}
              </h3>
              <CodeBlock
                language="json"
                code={`{
  "hooks": { "enabled": true, "token": "<your-token>" },
  "plugins": {
    "enabled": true,
    "entries": {
      "chorus-openclaw-plugin": {
        "enabled": true,
        "config": {
          "chorusUrl": "${origin}",
          "apiKey": "${displayKey}",
          "autoStart": true
        }
      }
    }
  }
}`}
              />
            </div>

            <div>
              <h3 className="mb-2 text-sm font-medium text-foreground">
                {t("install.openClaw.step3Title")}
              </h3>
              <p className="text-sm text-muted-foreground">
                {t("install.openClaw.step3Desc")}
              </p>
            </div>

            {/* Troubleshooting collapsible */}
            <Collapsible>
              <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
                <ChevronDown className="size-4 transition-transform duration-200 [[data-state=open]>&]:rotate-180" />
                {t("install.openClaw.troubleshootingTitle")}
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="mt-2 rounded-md border border-amber-500/20 bg-amber-500/5 p-3">
                  <p className="text-sm font-medium text-amber-600 dark:text-amber-400">
                    {t("install.openClaw.troubleshootingError")}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t("install.openClaw.troubleshootingFix")}
                  </p>
                </div>
              </CollapsibleContent>
            </Collapsible>
          </TabsContent>

          {/* Other Agents Tab */}
          <TabsContent value="other" className="mt-4 space-y-4">
            <p className="text-sm text-muted-foreground">
              {t("install.other.description")}
            </p>
            <CodeBlock
              code={`Please install and configure the Chorus AI-DLC collaboration platform.

Chorus URL: ${origin}
API Key: ${displayKey}

Read the setup instructions from:
${origin}/skill/chorus/SKILL.md

Follow the "Setup" section to configure the MCP server,
then call chorus_checkin() to verify the connection.`}
            />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
