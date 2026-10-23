// The IPv4 ranges of Google's own services: every range Google announces, minus the ranges its
// Cloud customers can rent. Gmail's SMTP relay answers DNS with a different frontend for each
// client, and every one of them sits in these ranges, while no customer VM does. Google publishes
// both lists and documents this subtraction for reaching its services.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const lists = {
  google: "https://www.gstatic.com/ipranges/goog.json",
  cloud: "https://www.gstatic.com/ipranges/cloud.json",
};

/** The fewest CIDRs covering the addresses of include outside exclude, in address order. */
export function subtract(include, exclude) {
  return [...difference(merge(include), merge(exclude))].flatMap((interval) => [...cidrs(interval)]);
}

/** Google's service ranges as they stand now. Throws rather than return an empty list. */
export async function googleServiceRanges() {
  const ranges = subtract(await ipv4(lists.google), await ipv4(lists.cloud));
  // An empty list would close every rule that matches it, so a broken download must never yield one.
  if (ranges.length === 0) throw new Error("Google's lists left no service range");
  return ranges;
}

// A CIDR as its first and last address numbers. Arithmetic, not bit operators, which wrap at 2^31.
function interval(cidr) {
  const [address, bits] = cidr.split("/");
  const first = address.split(".").reduce((number, octet) => number * 256 + Number(octet), 0);
  return [first, first + 2 ** (32 - Number(bits)) - 1];
}

const address = (number) => [2 ** 24, 2 ** 16, 2 ** 8, 1].map((place) => Math.floor(number / place) % 256).join(".");

// Sorted intervals with every overlap and adjacency joined.
function merge(ranges) {
  const merged = [];
  for (const [first, last] of ranges.map(interval).sort((a, b) => a[0] - b[0])) {
    const previous = merged.at(-1);
    if (previous && first <= previous[1] + 1) previous[1] = Math.max(previous[1], last);
    else merged.push([first, last]);
  }
  return merged;
}

// Yields the parts of each include interval that no exclude interval covers. Both are merged, so
// the exclude cursor only moves forward.
function* difference(include, exclude) {
  let next = 0;
  for (let [first, last] of include) {
    while (next < exclude.length && exclude[next][1] < first) next++;
    for (let i = next; i < exclude.length && exclude[i][0] <= last; i++) {
      if (exclude[i][0] > first) yield [first, exclude[i][0] - 1];
      first = Math.max(first, exclude[i][1] + 1);
    }
    if (first <= last) yield [first, last];
  }
}

// Yields the largest aligned block that starts each remaining stretch of the interval.
function* cidrs([first, last]) {
  while (first <= last) {
    let size = 2 ** 32;
    while (first % size !== 0 || first + size - 1 > last) size /= 2;
    yield `${address(first)}/${32 - Math.log2(size)}`;
    first += size;
  }
}

async function ipv4(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
  const { prefixes } = await response.json();
  return prefixes.flatMap((prefix) => prefix.ipv4Prefix ?? []);
}

async function main([outputPath]) {
  writeFileSync(outputPath, `${JSON.stringify(await googleServiceRanges(), null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
}
