import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

// Resource monitoring configuration
const MONITOR_INTERVAL = 2000; // Check every 2 seconds
const MONITOR_DURATION = 300000; // Monitor for 5 minutes

console.log("🔍 Starting system resource monitoring...");
console.log(`⏱️  Monitoring interval: ${MONITOR_INTERVAL}ms`);
console.log(`⏰ Total duration: ${MONITOR_DURATION / 1000}s`);
console.log("📊 Press Ctrl+C to stop monitoring\n");

let monitorCount = 0;
const startTime = Date.now();

async function getSystemStats() {
	try {
		// Get CPU usage
		const { stdout: cpuOutput } = await execAsync(
			'top -l 1 -n 0 | grep "CPU usage"'
		);
		const cpuMatch = cpuOutput.match(
			/CPU usage: (\d+\.?\d*)% user, (\d+\.?\d*)% sys, (\d+\.?\d*)% idle/
		);

		// Get memory usage
		const { stdout: memOutput } = await execAsync(
			'vm_stat | grep "Pages free:"'
		);
		const memMatch = memOutput.match(/Pages free:\s+(\d+)/);

		// Get disk I/O (if available)
		let diskIO = "N/A";
		try {
			const { stdout: diskOutput } = await execAsync("iostat -d 1 1 | tail -1");
			diskIO = diskOutput.trim();
		} catch (e) {
			// iostat might not be available
		}

		// Get network connections
		const { stdout: netOutput } = await execAsync(
			"netstat -an | grep ESTABLISHED | wc -l"
		);

		return {
			cpu: cpuMatch
				? {
						user: parseFloat(cpuMatch[1]),
						sys: parseFloat(cpuMatch[2]),
						idle: parseFloat(cpuMatch[3]),
				  }
				: null,
			memory: memMatch ? parseInt(memMatch[1]) : null,
			diskIO,
			connections: parseInt(netOutput.trim()),
		};
	} catch (error) {
		return { error: error.message };
	}
}

async function monitorResources() {
	const stats = await getSystemStats();
	const elapsed = (Date.now() - startTime) / 1000;

	console.log(
		`\n📊 Monitor #${++monitorCount} (${elapsed.toFixed(1)}s elapsed)`
	);
	console.log("=".repeat(50));

	if (stats.error) {
		console.log(`❌ Error: ${stats.error}`);
		return;
	}

	if (stats.cpu) {
		console.log(`🖥️  CPU Usage:`);
		console.log(`   User: ${stats.cpu.user.toFixed(1)}%`);
		console.log(`   System: ${stats.cpu.sys.toFixed(1)}%`);
		console.log(`   Idle: ${stats.cpu.idle.toFixed(1)}%`);
		console.log(`   Total Load: ${(100 - stats.cpu.idle).toFixed(1)}%`);
	}

	if (stats.memory) {
		// Convert pages to MB (1 page = 4KB on macOS)
		const freeMB = (stats.memory * 4) / 1024;
		console.log(`🧠 Memory: ${freeMB.toFixed(1)} MB free`);
	}

	console.log(`🌐 Network Connections: ${stats.connections}`);

	if (stats.diskIO !== "N/A") {
		console.log(`💾 Disk I/O: ${stats.diskIO}`);
	}

	// Check if we should continue monitoring
	if (elapsed < MONITOR_DURATION / 1000) {
		setTimeout(monitorResources, MONITOR_INTERVAL);
	} else {
		console.log("\n⏰ Monitoring duration completed");
		process.exit(0);
	}
}

// Start monitoring
monitorResources();

// Handle graceful shutdown
process.on("SIGINT", () => {
	console.log("\n⏹️  Stopping resource monitoring...");
	process.exit(0);
});
