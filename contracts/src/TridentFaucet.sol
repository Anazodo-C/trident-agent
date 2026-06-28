// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./TridentToken.sol";

contract TridentFaucet is Ownable, ReentrancyGuard {
    TridentToken public immutable tridToken;
    IERC20 public immutable usdc;

    uint256 public claimAmount = 10 * 1e6;
    uint256 public cooldown = 1 hours;
    mapping(address => uint256) public lastClaim;
    uint256 public totalAgentsBootstrapped;

    event AgentBootstrapped(address indexed agent, uint256 tridAmount, uint256 timestamp);

    constructor(address initialOwner, address _tridToken, address _usdc) Ownable(initialOwner) {
        tridToken = TridentToken(_tridToken);
        usdc = IERC20(_usdc);
    }

    function claim() external nonReentrant {
        require(block.timestamp >= lastClaim[msg.sender] + cooldown, "Cooldown not elapsed");
        lastClaim[msg.sender] = block.timestamp;
        totalAgentsBootstrapped++;
        tridToken.mint(msg.sender, claimAmount);
        emit AgentBootstrapped(msg.sender, claimAmount, block.timestamp);
    }

    function canClaim(address agent) external view returns (bool eligible, uint256 secondsRemaining) {
        if (block.timestamp >= lastClaim[agent] + cooldown) return (true, 0);
        return (false, (lastClaim[agent] + cooldown) - block.timestamp);
    }

    function setClaimAmount(uint256 amount) external onlyOwner { claimAmount = amount; }
    function setCooldown(uint256 _cooldown) external onlyOwner { cooldown = _cooldown; }
    function resetCooldown(address agent) external onlyOwner { lastClaim[agent] = 0; }
}
