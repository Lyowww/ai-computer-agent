import { config as loadDotenv } from "dotenv";
import { startPlanServer } from "./http/server.js";

loadDotenv();
startPlanServer();
