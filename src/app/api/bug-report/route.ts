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
    let githubError = '';

    if (token && repo) {
      try {
        // Step 1: Upload screenshot to repo if present
        let screenshotGitUrl = '';
        let screenshotUploadError = '';
        let screenshotFilename = '';
        
        if (screenshotDataUrl) {
          try {
            const base64Data = screenshotDataUrl.replace(/^data:image\/\w+;base64,/, '');
            screenshotFilename = `bug-screenshots/${reportId}.png`;
            const uploadRes = await fetch(
              `https://api.github.com/repos/${repo}/contents/${screenshotFilename}`,
              {
                method: 'PUT',
                headers: {
                  Authorization: `Bearer ${token}`,
                  'Content-Type': 'application/json',
                  Accept: 'application/vnd.github+json',
                },
                body: JSON.stringify({
                  message: `Bug report screenshot: ${reportId}`,
                  content: base64Data,
                }),
              },
            );
            if (uploadRes.ok) {
              const uploadData = await uploadRes.json();
              // Use the github.com raw blob URL so it respects repo visibility without exposing a token
              screenshotGitUrl = `https://github.com/${repo}/blob/main/${screenshotFilename}?raw=true`;
              console.log(`[BugReport] Screenshot uploaded: ${screenshotGitUrl}`);
            } else {
              const errText = await uploadRes.text();
              console.warn(`[BugReport] Screenshot upload failed: ${errText}`);
              try {
                screenshotUploadError = JSON.parse(errText).message || errText;
              } catch {
                screenshotUploadError = errText;
              }
            }
          } catch (err: any) {
            console.warn('[BugReport] Screenshot upload error:', err);
            screenshotUploadError = err.message;
          }
        }

        // Step 2: Build issue body (no base64, stay under 65536 chars)
        const issueParts: string[] = [];
        issueParts.push(`## Bug Report`);
        issueParts.push(`\n**Submitted:** ${new Date().toISOString()}`);
        issueParts.push(`\n### Description\n${description}`);

        if (screenshotGitUrl) {
          issueParts.push(`\n### Screenshot\n![Screenshot](${screenshotGitUrl})`);
        } else if (screenshotDataUrl) {
          issueParts.push(`\n### Screenshot\n> [!WARNING]\n> Failed to upload screenshot to GitHub: **${screenshotUploadError}**\n\nThe screenshot was captured but could not be attached here. It is saved locally on the server at:\n\`${screenshotPath}\``);
        }

        // Trim logs to fit within GitHub's 65536 char body limit
        const MAX_LOG_CHARS = 20000;
        if (clientLogs) {
          const trimmed = clientLogs.length > MAX_LOG_CHARS ? clientLogs.slice(-MAX_LOG_CHARS) : clientLogs;
          issueParts.push(`\n### Client Logs (last 5 min)\n<details>\n<summary>Click to expand</summary>\n\n\`\`\`\n${trimmed}\n\`\`\`\n</details>`);
        }

        if (serverLogs) {
          const trimmed = serverLogs.length > MAX_LOG_CHARS ? serverLogs.slice(-MAX_LOG_CHARS) : serverLogs;
          issueParts.push(`\n### Server Logs\n<details>\n<summary>Click to expand</summary>\n\n\`\`\`\n${trimmed}\n\`\`\`\n</details>`);
        }

        // Step 3: Create the issue
        const issueBody = issueParts.join('\n');
        console.log(`[BugReport] Issue body length: ${issueBody.length} chars`);

        const issueRes = await fetch(`https://api.github.com/repos/${repo}/issues`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Accept: 'application/vnd.github+json',
          },
          body: JSON.stringify({
            title: `[Bug] ${description.slice(0, 100)}`,
            body: issueBody,
            labels: ['bug'],
          }),
        });

        if (issueRes.ok) {
          const issueData = await issueRes.json();
          issueUrl = issueData.html_url;
          console.log(`[BugReport] GitHub issue created: ${issueUrl}`);
        } else {
          const errText = await issueRes.text();
          console.error(`[BugReport] GitHub issue creation failed: ${errText}`);
          // Don't fail the whole request — local save succeeded
          githubError = `GitHub: ${JSON.parse(errText)?.message || errText}`;
        }
      } catch (err: any) {
        console.error('[BugReport] GitHub error:', err);
        githubError = err.message;
      }
    }

    return NextResponse.json({
      success: true,
      reportPath,
      issueUrl: issueUrl || undefined,
      githubError: githubError || undefined,
    });
  } catch (err: any) {
    console.error('[BugReport] Error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
