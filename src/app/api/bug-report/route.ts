// Next.js API route: POST /api/bug-report
// Saves bug reports locally AND optionally creates a GitHub issue.
// Local reports are always saved to next-web/bug-reports/ for easy access.

import { NextRequest, NextResponse } from 'next/server';
import { writeFile, mkdir } from 'fs/promises';
import path from 'path';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { description, screenshotDataUrl, clientLogs, serverLogs } = body;

    if (!description) {
      return NextResponse.json({ error: 'Description is required' }, { status: 400 });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const reportId = `bug-${timestamp}`;

    // ─── Always save locally ───────────────────────────
    const reportsDir = path.join(process.cwd(), 'bug-reports');
    await mkdir(reportsDir, { recursive: true });

    // Save screenshot as PNG
    let screenshotPath = '';
    if (screenshotDataUrl) {
      const base64Data = screenshotDataUrl.replace(/^data:image\/\w+;base64,/, '');
      screenshotPath = path.join(reportsDir, `${reportId}.png`);
      await writeFile(screenshotPath, Buffer.from(base64Data, 'base64'));
    }

    // Save report as markdown
    const reportParts: string[] = [];
    reportParts.push(`# Bug Report: ${reportId}`);
    reportParts.push(`\n**Submitted:** ${new Date().toISOString()}`);
    reportParts.push(`\n## Description\n${description}`);

    if (screenshotPath) {
      reportParts.push(`\n## Screenshot\nSaved to: ${screenshotPath}`);
    }

    if (clientLogs) {
      reportParts.push(`\n## Client Logs (last 5 min)\n\`\`\`\n${clientLogs}\n\`\`\``);
    }

    if (serverLogs) {
      reportParts.push(`\n## Server Logs\n\`\`\`\n${serverLogs}\n\`\`\``);
    }

    const reportPath = path.join(reportsDir, `${reportId}.md`);
    await writeFile(reportPath, reportParts.join('\n'));

    console.log(`[BugReport] Saved locally: ${reportPath}`);

    // ─── Optionally create GitHub issue ────────────────
    const token = process.env.GITHUB_TOKEN;
    const repo = process.env.GITHUB_REPO;
    let issueUrl = '';

    if (token && repo) {
      try {
        // Build issue body
        const issueParts: string[] = [];
        issueParts.push(`## Bug Report`);
        issueParts.push(`\n**Submitted:** ${new Date().toISOString()}`);
        issueParts.push(`\n### Description\n${description}`);

        if (screenshotDataUrl) {
          // Try to embed — GitHub renders base64 inline images
          issueParts.push(`\n### Screenshot\n![Screenshot](${screenshotDataUrl})`);
        }

        if (clientLogs) {
          const trimmed = clientLogs.length > 50000 ? clientLogs.slice(-50000) : clientLogs;
          issueParts.push(`\n### Client Logs (last 5 min)\n<details>\n<summary>Click to expand</summary>\n\n\`\`\`\n${trimmed}\n\`\`\`\n</details>`);
        }

        if (serverLogs) {
          const trimmed = serverLogs.length > 50000 ? serverLogs.slice(-50000) : serverLogs;
          issueParts.push(`\n### Server Logs\n<details>\n<summary>Click to expand</summary>\n\n\`\`\`\n${trimmed}\n\`\`\`\n</details>`);
        }

        const issueRes = await fetch(`https://api.github.com/repos/${repo}/issues`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Accept: 'application/vnd.github+json',
          },
          body: JSON.stringify({
            title: `[Bug] ${description.slice(0, 100)}`,
            body: issueParts.join('\n'),
            labels: ['bug'],
          }),
        });

        if (issueRes.ok) {
          const issueData = await issueRes.json();
          issueUrl = issueData.html_url;
          console.log(`[BugReport] GitHub issue created: ${issueUrl}`);
        } else {
          const errText = await issueRes.text();
          console.warn(`[BugReport] GitHub issue creation failed (non-fatal): ${errText}`);
        }
      } catch (err) {
        console.warn('[BugReport] GitHub issue creation failed (non-fatal):', err);
      }
    }

    return NextResponse.json({
      success: true,
      reportPath,
      issueUrl: issueUrl || undefined,
    });
  } catch (err: any) {
    console.error('[BugReport] Error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
