"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_cron_1 = __importDefault(require("node-cron"));
const database_1 = __importDefault(require("../config/database"));
class RiskCalculatorJob {
    start() {
        console.log('Risk Calculator Job starting...');
        node_cron_1.default.schedule('0 */12 * * *', async () => {
            try {
                console.log('Running risk calculator job at:', new Date().toISOString());
                const regions = ['Muğla', 'Antalya', 'Mersin', 'Aydın', 'İzmir', 'Denizli'];
                for (const region of regions) {
                    const generalRiskScore = Math.floor(Math.random() * 100);
                    const riskLevel = this.calculateRiskLevel(generalRiskScore);
                    const temperature = Math.floor(Math.random() * (45 - 20) + 20);
                    const humidity = Math.floor(Math.random() * (100 - 20) + 20);
                    const windSpeed = Math.floor(Math.random() * (80 - 10) + 10);
                    const windDirection = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.floor(Math.random() * 8)];
                    const drynessIndex = Math.floor(Math.random() * 100);
                    const vegetationDensity = Math.floor(Math.random() * 100);
                    const query = `
            INSERT INTO risk_data (region, date, general_risk_score, risk_level, temperature, humidity, wind_speed, wind_direction, dryness_index, vegetation_density)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          `;
                    const values = [
                        region,
                        new Date(),
                        generalRiskScore,
                        riskLevel,
                        temperature,
                        humidity,
                        windSpeed,
                        windDirection,
                        drynessIndex,
                        vegetationDensity,
                    ];
                    await database_1.default.query(query, values);
                    console.log(`Risk data saved for ${region}: Score=${generalRiskScore}, Level=${riskLevel}`);
                }
                console.log('Risk calculator job completed successfully');
            }
            catch (error) {
                console.error('Error in risk calculator job:', error);
            }
        });
    }
    calculateRiskLevel(score) {
        if (score >= 75)
            return 'Critical';
        if (score >= 50)
            return 'High';
        if (score >= 25)
            return 'Medium';
        return 'Low';
    }
}
exports.default = new RiskCalculatorJob();
