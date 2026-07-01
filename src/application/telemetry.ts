// Copyright (c) 2026 Geoff Seemueller
//
// Licensed under the MIT License or Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// See LICENSE-MIT or LICENSE-APACHE for the full text.
//
// Additionally, this file is subject to the Revenue Sharing Agreement terms
// as defined in REVENUE-SHARING.md for covered organizations.

//! Anonymous telemetry collection for usage analytics and IP protection.
//!
//! This module integrates with g-telemetry (https://github.com/geoffsee/g-telemetry)
//! to collect anonymous usage data that helps understand how the autopilot action is used
//! while protecting user privacy and intellectual property.
//!
//! The telemetry system is designed to be:
//! - **Anonymous by Design**: No PII, no IP logging, random instance IDs
//! - **Privacy First**: Respects `DO_NOT_TRACK=1` and `CARETTA_NO_TELEMETRY=1`
//! - **Minimal Impact**: Events are buffered and sent in the background

/// Hardcoded telemetry sink URL for IP protection - users cannot override this
const TELEMETRY_SINK_URL =
  "https://anon-telemetry-sink.seemueller.workers.dev/v1/events";
/// Hardcoded app ID for IP protection
const TELEMETRY_APP_ID = "caretta-autopilot";

// Singleton telemetry client instance
let telemetryClient: any | null = null;

/// Check if telemetry is disabled via environment variables
function isTelemetryDisabled(): boolean {
  // Respect DO_NOT_TRACK=1 (global opt-out)
  if (process.env.DO_NOT_TRACK === "1") {
    return true;
  }
  // Respect CARETTA_NO_TELEMETRY=1 (main Caretta opt-out)
  if (process.env.CARETTA_NO_TELEMETRY === "1") {
    return true;
  }
  // Respect app-specific opt-out
  if (process.env.CARETTA_AUTILOOT_NO_TELEMETRY === "1") {
    return true;
  }
  return false;
}

/// Initialize the telemetry client with hardcoded endpoint for IP protection
/// Only respects the enabled flag from environment - URL and app ID are fixed
/// Returns null if module is not available or telemetry is disabled
export function initializeTelemetry(): any | null {
  if (telemetryClient) {
    return telemetryClient;
  }

  // If telemetry is disabled, return null and don't initialize
  if (isTelemetryDisabled()) {
    return null;
  }

  // Try to load the module dynamically
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const module = require("@anon-telemetry/client");
    const TelemetryClient = module.TelemetryClient;

    telemetryClient = new TelemetryClient({
      appId: TELEMETRY_APP_ID,
      endpoint: TELEMETRY_SINK_URL,
      appVersion: process.env.CARETTA_VERSION || "0.0.0",
      platform: process.platform,
      telemetryEnabled: true, // Enabled by default, opt-out via env vars
    });

    return telemetryClient;
  } catch {
    // Module not available - telemetry will be a no-op
    return null;
  }
}

/// Get the global telemetry client, if available
export function getTelemetryClient(): any | null {
  return telemetryClient;
}

/// Track a telemetry event with the given name and optional properties
export function trackEvent(
  eventName: string,
  properties: Record<string, any> = {},
): void {
  const client = getTelemetryClient();
  if (client) {
    client.track(eventName, properties);
  }
}

// Event names for standard autopilot telemetry events
export const EventNames = {
  AUTILOOT_START: "autopilot_start",
  AUTILOOT_COMPLETE: "autopilot_complete",
  AUTILOOT_SKIPPED: "autopilot_skipped",
  DISPATCH_SENT: "dispatch_sent",
  EVALUATION_COMPLETE: "evaluation_complete",
  ERROR: "autopilot_error",
} as const;

/// Record autopilot start
export function recordAutopilotStart(repository: string): void {
  trackEvent(EventNames.AUTILOOT_START, { repository });
}

/// Record autopilot completion
export function recordAutopilotComplete(
  repository: string,
  durationMs: number,
  issuesEvaluated: number,
  prsEvaluated: number,
  dispatchesSent: number,
): void {
  trackEvent(EventNames.AUTILOOT_COMPLETE, {
    repository,
    duration_ms: durationMs,
    issues_evaluated: issuesEvaluated,
    prs_evaluated: prsEvaluated,
    dispatches_sent: dispatchesSent,
  });
}

/// Record autopilot skipped
export function recordAutopilotSkipped(
  repository: string,
  reason: string,
): void {
  trackEvent(EventNames.AUTILOOT_SKIPPED, {
    repository,
    reason,
  });
}

/// Record dispatch sent
export function recordDispatchSent(
  repository: string,
  issueNumber: number | string,
  agent: string,
  command: string,
): void {
  trackEvent(EventNames.DISPATCH_SENT, {
    repository,
    issue_number: String(issueNumber),
    agent,
    command,
  });
}

/// Record evaluation complete
export function recordEvaluationComplete(
  repository: string,
  openIssueCount: number,
  openPrCount: number,
  stalePrCount: number,
): void {
  trackEvent(EventNames.EVALUATION_COMPLETE, {
    repository,
    open_issue_count: openIssueCount,
    open_pr_count: openPrCount,
    stale_pr_count: stalePrCount,
  });
}

/// Record an error
export function recordError(
  errorType: string,
  message: string,
  repository?: string,
): void {
  const properties: Record<string, any> = {
    error_type: errorType,
    message,
  };
  if (repository) {
    properties.repository = repository;
  }
  trackEvent(EventNames.ERROR, properties);
}
