"use client";

import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { motion } from "framer-motion";
import { fadeInUp } from "@/lib/animation";
import { ChevronDown } from "lucide-react";
import { CodeBlock } from "./CodeBlock";

interface InstallGuideStepProps {
  apiKey: string | null;
  onNext: () => void;
  onBack?: () => void;
}

export function InstallGuideStep({ apiKey, onNext, onBack }: InstallGuideStepProps) {
  const t = useTranslations("onboarding");
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const displayKey = apiKey || "<YOUR_API_KEY>";

  return (
    <motion.div
      variants={fadeInUp}
      initial="initial"
      animate="animate"
      exit="exit"
      className="flex w-full max-w-2xl flex-col items-center gap-6"
    >
      <div className="text-center">
        <h2 className="text-lg font-semibold text-foreground">
          {t("steps.installGuide")}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("install.description")}
        </p>
      </div>

      <Card className="w-full">
        <CardContent className="p-6">
          <Tabs defaultValue="claude-code" className="w-full">
            <TabsList className="w-full">
              <TabsTrigger value="claude-code" className="flex-1">
                {t("install.tabs.claudeCode")}
              </TabsTrigger>
              <TabsTrigger value="openclaw" className="flex-1">
                {t("install.tabs.openClaw")}
              </TabsTrigger>
              <TabsTrigger value="other" className="flex-1">
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
                  code={`/plugin marketplace add Chorus-AIDLC/chorus\n/plugin install chorus@chorus-plugins`}
                />
              </div>
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

              <div>
                <h3 className="mb-2 text-sm font-medium text-foreground">
                  {t("install.openClaw.step4Title")}
                </h3>
                <p className="text-sm text-muted-foreground">
                  {t("install.openClaw.step4Desc")}
                </p>
                <CodeBlock code="/chorus status" />
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

      <div className="flex gap-2">
        {onBack && (
          <Button variant="outline" onClick={onBack}>
            {t("back")}
          </Button>
        )}
        <Button onClick={onNext}>{t("next")}</Button>
      </div>
    </motion.div>
  );
}
