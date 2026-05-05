import { Router, type IRouter } from "express";
import healthRouter from "./health";
import marketRouter from "./market";
import aiRouter from "./ai";
import alpacaRouter from "./alpaca";
import autopilotRouter from "./autopilot";
import aiBrainRouter from "./aiBrain";

const router: IRouter = Router();

router.use(healthRouter);
router.use(marketRouter);
router.use(aiRouter);
router.use(alpacaRouter);
router.use(autopilotRouter);
router.use(aiBrainRouter);

export default router;
