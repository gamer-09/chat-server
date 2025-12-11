#!/usr/bin/env node

// Test script to verify the scan manager fix
const { RepoScanManager } = require('./src/scan_manager');

async function testScanManager() {
  console.log('Testing scan manager fix...');
  
  // Create a scan manager instance
  const scanManager = new RepoScanManager();
  
  // Test with a repository that should have mixed file types
  const testJob = scanManager.create({
    owner: 'microsoft',
    repos: ['vscode'], // VS Code has many file types
    ghToken: process.env.GITHUB_TOKEN || '',
    maxBytesPerFile: 1024 * 1024, // 1MB
    includePatterns: [], // No include patterns (should include all)
    excludePatterns: [] // No exclude patterns
  });
  
  console.log(`Started scan job: ${testJob.id}`);
  
  // Listen for events to verify the fix
  testJob.on('count', (data) => {
    console.log(`Count event: total=${data.total}`);
    if (data.total === 0) {
      console.log('ERROR: Still getting 0 total files after fix!');
    } else {
      console.log('SUCCESS: Non-zero total files detected');
    }
  });
  
  testJob.on('progress', (data) => {
    console.log(`Progress: ${data.scanned}/${data.total} (${data.percent}%)`);
  });
  
  testJob.on('warn', (data) => {
    console.log('Warning:', data);
  });
  
  testJob.on('end', (data) => {
    console.log(`Scan completed: ${data.scanned}/${data.total} files`);
    if (data.total > 0 && data.scanned > 0) {
      console.log('SUCCESS: Scan processed files correctly');
    } else {
      console.log('ERROR: Scan still has issues');
    }
    process.exit(0);
  });
  
  testJob.on('error', (data) => {
    console.log('Scan error:', data);
    process.exit(1);
  });
  
  // Cancel after 30 seconds to avoid long-running test
  setTimeout(() => {
    console.log('Cancelling scan (timeout)');
    testJob.cancel();
    process.exit(0);
  }, 30000);
}

if (require.main === module) {
  testScanManager().catch(console.error);
}

module.exports = { testScanManager };
