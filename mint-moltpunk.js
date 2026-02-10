#!/usr/bin/env node

const API_KEY = process.env.MOLTBOOK_API_KEY;
if (!API_KEY) {
  console.error('Error: MOLTBOOK_API_KEY environment variable is required');
  process.exit(1);
}

const amount = process.argv[2] || '1';

const mintPayload = JSON.stringify({
  p: 'mbc-20',
  op: 'mint',
  tick: 'MOLTPUNK',
  amt: amount
});

async function mint() {
  const response = await fetch('https://www.moltbook.com/api/v1/posts', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      submolt: 'mbc20',
      title: 'Minting MOLTPUNK',
      content: mintPayload
    })
  });

  const result = await response.json();

  if (!response.ok) {
    console.error(`Mint failed (${response.status}):`, result);
    process.exit(1);
  }

  console.log('Mint successful:', result);
}

mint();
