import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const STACK_LIMIT = 256;
const CALL_LIMIT = 64;
const MEMORY_SIZE = 256;
const STEP_LIMIT = 1_000_000;
const OUTPUT_LIMIT = 65_536;

type Instruction = {
  immediate: number;
  pops: number;
  pushes: number;
};

const instructions: (Instruction | undefined)[] = Array(256);
function define(bytes: number[], immediate: number, pops: number, pushes: number) {
  for (const byte of bytes) instructions[byte] = { immediate, pops, pushes };
}

define([0x00, 0x34], 0, 0, 0);
define([0x01], 1, 0, 1);
define([0x02], 4, 0, 1);
define([0x03, 0x50, 0x51, 0x53], 0, 1, 0);
define([0x04], 0, 1, 2);
define([0x05], 0, 2, 2);
define([0x06], 0, 2, 3);
define([0x07], 0, 3, 3);
define([
  0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16,
  0x18, 0x19, 0x1a, 0x1c, 0x1d, 0x1e, 0x20, 0x21, 0x22,
], 0, 2, 1);
define([0x17, 0x1b, 0x40], 0, 1, 1);
define([0x30, 0x33], 2, 0, 0);
define([0x31, 0x32], 2, 1, 0);
define([0x41], 0, 2, 0);
define([0x52], 0, 0, 1);

function execute(program: Buffer, input: Buffer) {
  const stack = new Int32Array(STACK_LIMIT);
  const calls = new Int32Array(CALL_LIMIT);
  const memory = new Int32Array(MEMORY_SIZE);
  const output = Buffer.alloc(OUTPUT_LIMIT);
  let depth = 0;
  let callDepth = 0;
  let pc = 0;
  let inputOffset = 0;
  let written = 0;

  function finish(exit: number) {
    return { exit, stdout: output.subarray(0, written) };
  }

  for (let step = 0; step < STEP_LIMIT; step++) {
    if (pc < 0 || pc >= program.length) return finish(9);
    const opcode = program[pc++];
    const instruction = instructions[opcode];
    if (instruction === undefined) return finish(5);

    const operand = pc;
    pc += instruction.immediate;
    if (pc > program.length) return finish(9);
    const base = depth - instruction.pops;
    if (base < 0) return finish(2);
    const nextDepth = base + instruction.pushes;
    if (nextDepth > STACK_LIMIT) return finish(3);

    // The consumed operands remain in place until the instruction replaces them.
    const a = stack[base];
    const b = stack[base + 1];
    switch (opcode) {
      case 0x00: return finish(0); // HALT
      case 0x01: stack[base] = program.readInt8(operand); break;
      case 0x02: stack[base] = program.readInt32LE(operand); break;
      case 0x03: break; // POP
      case 0x04: stack[base + 1] = a; break;
      case 0x05:
        stack[base] = b;
        stack[base + 1] = a;
        break;
      case 0x06: stack[base + 2] = a; break;
      case 0x07:
        stack[base] = b;
        stack[base + 1] = stack[base + 2];
        stack[base + 2] = a;
        break;
      case 0x10: stack[base] = (a + b) | 0; break;
      case 0x11: stack[base] = (a - b) | 0; break;
      case 0x12: stack[base] = Math.imul(a, b); break;
      case 0x13:
      case 0x14:
      case 0x15:
      case 0x16:
        if (b === 0) return finish(4);
        if (opcode === 0x13) stack[base] = (a / b) | 0;
        if (opcode === 0x14) stack[base] = (a % b) | 0;
        if (opcode === 0x15) stack[base] = ((a >>> 0) / (b >>> 0)) | 0;
        if (opcode === 0x16) stack[base] = ((a >>> 0) % (b >>> 0)) | 0;
        break;
      case 0x17: stack[base] = -a | 0; break;
      case 0x18: stack[base] = a & b; break;
      case 0x19: stack[base] = a | b; break;
      case 0x1a: stack[base] = a ^ b; break;
      case 0x1b: stack[base] = ~a; break;
      case 0x1c: stack[base] = a << b; break;
      case 0x1d: stack[base] = a >> b; break;
      case 0x1e: stack[base] = (a >>> b) | 0; break;
      case 0x20: stack[base] = Number(a === b); break;
      case 0x21: stack[base] = Number(a < b); break;
      case 0x22: stack[base] = Number((a >>> 0) < (b >>> 0)); break;
      case 0x30: pc += program.readInt16LE(operand); break;
      case 0x31:
        if (a === 0) pc += program.readInt16LE(operand);
        break;
      case 0x32:
        if (a !== 0) pc += program.readInt16LE(operand);
        break;
      case 0x33:
        if (callDepth === CALL_LIMIT) return finish(7);
        calls[callDepth++] = pc;
        pc = program.readUInt16LE(operand);
        break;
      case 0x34:
        if (callDepth === 0) return finish(8);
        pc = calls[--callDepth];
        break;
      case 0x40:
        if (a < 0 || a >= MEMORY_SIZE) return finish(6);
        stack[base] = memory[a];
        break;
      case 0x41:
        if (b < 0 || b >= MEMORY_SIZE) return finish(6);
        memory[b] = a;
        break;
      case 0x50: {
        const decimal = String(a);
        if (written + decimal.length > OUTPUT_LIMIT) return finish(11);
        output.write(decimal, written, 'ascii');
        written += decimal.length;
        break;
      }
      case 0x51:
        if (written === OUTPUT_LIMIT) return finish(11);
        output[written++] = a & 255;
        break;
      case 0x52:
        stack[base] = inputOffset < input.length ? input[inputOffset++] : -1;
        break;
      case 0x53: return finish(a & 255);
    }
    depth = nextDepth;
  }

  return finish(10);
}

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const instances = readdirSync(inputDir, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name)
  .sort();

for (const id of instances) {
  const source = join(inputDir, id);
  const result = execute(readFileSync(join(source, 'program.bin')), readFileSync(join(source, 'input.bin')));
  const destination = join(outputDir, id);
  mkdirSync(destination, { recursive: true });
  writeFileSync(join(destination, 'stdout.bin'), result.stdout);
  writeFileSync(join(destination, 'exit.txt'), String(result.exit) + '\n');
}
