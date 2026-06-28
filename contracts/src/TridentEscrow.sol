// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./AgentRegistry.sol";

contract TridentEscrow is Ownable, ReentrancyGuard {
    IERC20 public immutable trid;
    AgentRegistry public immutable registry;

    enum JobStatus { PENDING, COMPLETED, FAILED, DISPUTED, RECOVERED }
    enum AnomalyType { NONE, OVERPAYMENT, DUPLICATE, FAILED_DELIVERY }

    struct Job {
        uint256 jobId;
        address buyer;
        address seller;
        uint256 agreedAmount;
        uint256 actualPaid;
        uint256 serviceFee;
        JobStatus status;
        AnomalyType anomaly;
        string serviceType;
        bytes32 jobHash;
        uint256 createdAt;
        uint256 completedAt;
        uint256 deadline;
        bool retrobotFlagged;
        string retrobotReason;
    }

    mapping(uint256 => Job) public jobs;
    mapping(bytes32 => uint256) public jobHashToId;

    address public feeTreasury;
    uint256 public platformFeeBps = 100;
    uint256 private _nextJobId = 1;
    uint256 public totalJobsCreated;
    uint256 public totalTridEscrowed;
    uint256 public totalRecovered;
    address public retrobot;

    event JobCreated(
        uint256 indexed jobId,
        address indexed buyer,
        address indexed seller,
        uint256 amount,
        string serviceType
    );
    event JobCompleted(uint256 indexed jobId, address indexed seller, uint256 amount);
    event JobFailed(uint256 indexed jobId, address indexed buyer, uint256 refundAmount);
    event AnomalyFlagged(uint256 indexed jobId, AnomalyType anomaly, string reason);
    event FundsRecovered(uint256 indexed jobId, address indexed recipient, uint256 amount);

    modifier onlyRetrobot() { require(msg.sender == retrobot, "Not Retrobot"); _; }
    modifier jobExists(uint256 jobId) { require(jobId > 0 && jobId < _nextJobId, "Job not found"); _; }

    constructor(address initialOwner, address _trid, address _registry, address _feeTreasury)
        Ownable(initialOwner)
    {
        trid = IERC20(_trid);
        registry = AgentRegistry(_registry);
        feeTreasury = _feeTreasury;
    }

    function createJob(
        address seller,
        uint256 agreedAmount,
        string calldata serviceType,
        bytes32 jobSalt,
        uint256 deadlineSeconds
    ) external nonReentrant returns (uint256 jobId) {
        require(agreedAmount > 0, "Amount must be > 0");
        require(seller != msg.sender, "Cannot hire yourself");
        uint256 fee = (agreedAmount * platformFeeBps) / 10000;
        uint256 totalLocked = agreedAmount + fee;
        bytes32 jobHash = keccak256(
            abi.encodePacked(msg.sender, seller, agreedAmount, serviceType, jobSalt)
        );
        require(jobHashToId[jobHash] == 0, "Duplicate job");
        require(trid.transferFrom(msg.sender, address(this), totalLocked), "Transfer failed");
        jobId = _nextJobId++;
        totalJobsCreated++;
        totalTridEscrowed += totalLocked;
        jobs[jobId] = Job({
            jobId: jobId,
            buyer: msg.sender,
            seller: seller,
            agreedAmount: agreedAmount,
            actualPaid: totalLocked,
            serviceFee: fee,
            status: JobStatus.PENDING,
            anomaly: AnomalyType.NONE,
            serviceType: serviceType,
            jobHash: jobHash,
            createdAt: block.timestamp,
            completedAt: 0,
            deadline: block.timestamp + deadlineSeconds,
            retrobotFlagged: false,
            retrobotReason: ""
        });
        jobHashToId[jobHash] = jobId;
        emit JobCreated(jobId, msg.sender, seller, agreedAmount, serviceType);
    }

    function confirmDelivery(uint256 jobId) external nonReentrant jobExists(jobId) {
        Job storage job = jobs[jobId];
        require(job.status == JobStatus.PENDING, "Job not pending");
        require(msg.sender == job.seller || msg.sender == job.buyer, "Not authorised");
        require(!job.retrobotFlagged, "Flagged by Retrobot");
        job.status = JobStatus.COMPLETED;
        job.completedAt = block.timestamp;
        require(trid.transfer(job.seller, job.agreedAmount), "Seller transfer failed");
        if (job.serviceFee > 0) require(trid.transfer(feeTreasury, job.serviceFee), "Fee transfer failed");
        uint256 sellerAgentId = registry.addressToAgentId(job.seller);
        uint256 buyerAgentId = registry.addressToAgentId(job.buyer);
        if (sellerAgentId != 0) registry.recordJobCompletion(sellerAgentId, true, job.agreedAmount, true);
        if (buyerAgentId != 0) registry.recordJobCompletion(buyerAgentId, true, job.agreedAmount, false);
        emit JobCompleted(jobId, job.seller, job.agreedAmount);
    }

    function flagAnomaly(uint256 jobId, AnomalyType anomaly, string calldata reason)
        external onlyRetrobot jobExists(jobId)
    {
        Job storage job = jobs[jobId];
        require(job.status == JobStatus.PENDING, "Cannot flag completed job");
        job.retrobotFlagged = true;
        job.anomaly = anomaly;
        job.retrobotReason = reason;
        job.status = JobStatus.DISPUTED;
        emit AnomalyFlagged(jobId, anomaly, reason);
    }

    function executeRecovery(
        uint256 jobId,
        address recipient,
        uint256 amount,
        string calldata recoveryReason
    ) external onlyRetrobot nonReentrant jobExists(jobId) {
        Job storage job = jobs[jobId];
        require(job.status == JobStatus.DISPUTED, "Job not disputed");
        require(amount <= job.actualPaid, "Recovery exceeds locked amount");
        job.status = JobStatus.RECOVERED;
        job.completedAt = block.timestamp;
        totalRecovered += amount;
        require(trid.transfer(recipient, amount), "Recovery transfer failed");
        uint256 sellerAgentId = registry.addressToAgentId(job.seller);
        if (sellerAgentId != 0) registry.slashReputation(sellerAgentId, 300, recoveryReason);
        emit FundsRecovered(jobId, recipient, amount);
    }

    function claimDeadlineRefund(uint256 jobId) external nonReentrant jobExists(jobId) {
        Job storage job = jobs[jobId];
        require(job.status == JobStatus.PENDING, "Job not pending");
        require(msg.sender == job.buyer, "Not the buyer");
        require(block.timestamp > job.deadline, "Deadline not passed");
        job.status = JobStatus.FAILED;
        job.completedAt = block.timestamp;
        job.anomaly = AnomalyType.FAILED_DELIVERY;
        require(trid.transfer(job.buyer, job.actualPaid), "Refund failed");
        emit JobFailed(jobId, job.buyer, job.actualPaid);
    }

    function getJob(uint256 jobId) external view jobExists(jobId) returns (Job memory) {
        return jobs[jobId];
    }

    function setRetrobot(address _retrobot) external onlyOwner { retrobot = _retrobot; }
    function setFeeTreasury(address _treasury) external onlyOwner { feeTreasury = _treasury; }
}
